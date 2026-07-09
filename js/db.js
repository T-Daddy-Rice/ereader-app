// Thin wrapper around IndexedDB.
//
// If you haven't used IndexedDB before: it's the browser's built-in
// database for storing larger amounts of structured data client-side
// (localStorage is capped around 5-10MB and string-only, which is too small
// for whole EPUB files). Its native API is callback-based and clunky, so
// everything in this file wraps it in Promises you can `await` normally,
// similar to how you'd wrap a callback-style library in Python with
// `asyncio.Future`.

import { DB_NAME, DB_VERSION } from './constants.js';

// Module-level cache so we only open the database connection once, no
// matter how many other modules import and call these functions.
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Runs once, the very first time this database (or this DB_VERSION) is
    // opened - this is where object stores ("tables") get created.
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains('progress')) {
        // One record per book, keyed directly by bookId (no separate id).
        db.createObjectStore('progress', { keyPath: 'bookId' });
      }

      if (!db.objectStoreNames.contains('bookmarks')) {
        const store = db.createObjectStore('bookmarks', { keyPath: 'id', autoIncrement: true });
        store.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains('summaries')) {
        // id is a composite string key "<bookId>:<spineIndex>" so a summary
        // for a given chapter of a given book can be looked up directly.
        const store = db.createObjectStore('summaries', { keyPath: 'id' });
        store.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains('chatHistory')) {
        // One record per book, holding the full ordered message list.
        db.createObjectStore('chatHistory', { keyPath: 'bookId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

// Wraps a single IDBRequest in a Promise.
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStore(storeName, mode = 'readonly') {
  const db = await openDB();
  const transaction = db.transaction(storeName, mode);
  return transaction.objectStore(storeName);
}

// ---------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------

export async function addBook(book) {
  const store = await getStore('books', 'readwrite');
  const record = {
    title: book.title,
    author: book.author || 'Unknown author',
    coverBlob: book.coverBlob || null,
    fileBlob: book.fileBlob,
    dateAdded: Date.now(),
  };
  return promisifyRequest(store.add(record)); // resolves with the new auto-generated id
}

export async function getBook(id) {
  const store = await getStore('books');
  return promisifyRequest(store.get(id));
}

export async function getAllBooks() {
  const store = await getStore('books');
  const books = await promisifyRequest(store.getAll());
  return books.sort((a, b) => b.dateAdded - a.dateAdded);
}

export async function deleteBook(id) {
  // Clean up everything associated with this book, not just the book
  // record itself, so deleting a book doesn't leave orphaned data behind.
  const db = await openDB();
  const storeNames = ['books', 'progress', 'bookmarks', 'summaries', 'chatHistory'];
  const transaction = db.transaction(storeNames, 'readwrite');

  transaction.objectStore('books').delete(id);
  transaction.objectStore('progress').delete(id);
  transaction.objectStore('chatHistory').delete(id);

  const bookmarkIndex = transaction.objectStore('bookmarks').index('bookId');
  const bookmarkCursorRequest = bookmarkIndex.openCursor(IDBKeyRange.only(id));
  bookmarkCursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  const summaryIndex = transaction.objectStore('summaries').index('bookId');
  const summaryCursorRequest = summaryIndex.openCursor(IDBKeyRange.only(id));
  summaryCursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ---------------------------------------------------------------------
// Reading progress (current position + furthest position ever reached)
// ---------------------------------------------------------------------

export async function getProgress(bookId) {
  const store = await getStore('progress');
  const record = await promisifyRequest(store.get(bookId));
  return (
    record || {
      bookId,
      currentCfi: null,
      currentSpineIndex: 0,
      furthestSpineIndex: 0,
      lastReadAt: null,
    }
  );
}

// Merges `updates` into the existing progress record for this book and
// saves it. Always bumps lastReadAt to now.
export async function updateProgress(bookId, updates) {
  const existing = await getProgress(bookId);
  const merged = { ...existing, ...updates, bookId, lastReadAt: Date.now() };
  const store = await getStore('progress', 'readwrite');
  await promisifyRequest(store.put(merged));
  return merged;
}

// ---------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------

export async function addBookmark(bookId, cfi, label) {
  const store = await getStore('bookmarks', 'readwrite');
  const record = { bookId, cfi, label: label || '', createdAt: Date.now() };
  return promisifyRequest(store.add(record));
}

export async function getBookmarks(bookId) {
  const store = await getStore('bookmarks');
  const index = store.index('bookId');
  const bookmarks = await promisifyRequest(index.getAll(IDBKeyRange.only(bookId)));
  return bookmarks.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteBookmark(id) {
  const store = await getStore('bookmarks', 'readwrite');
  return promisifyRequest(store.delete(id));
}

// ---------------------------------------------------------------------
// Chapter summaries (lazily generated, cached forever per content hash)
// ---------------------------------------------------------------------

function summaryId(bookId, spineIndex) {
  return `${bookId}:${spineIndex}`;
}

export async function getSummary(bookId, spineIndex) {
  const store = await getStore('summaries');
  return promisifyRequest(store.get(summaryId(bookId, spineIndex)));
}

export async function saveSummary(bookId, spineIndex, contentHash, summaryText) {
  const store = await getStore('summaries', 'readwrite');
  const record = {
    id: summaryId(bookId, spineIndex),
    bookId,
    spineIndex,
    contentHash,
    summaryText,
    generatedAt: Date.now(),
  };
  await promisifyRequest(store.put(record));
  return record;
}

// Returns cached summaries for spine indices [0, furthestSpineIndex]
// (inclusive - furthestSpineIndex is a chapter the reader has actually
// reached), in spine order. Any chapter not yet summarized is simply
// missing from the result - it's the caller's job (see summarizer.js) to
// fill gaps in.
export async function getSummariesUpTo(bookId, furthestSpineIndex) {
  const store = await getStore('summaries');
  const index = store.index('bookId');
  const all = await promisifyRequest(index.getAll(IDBKeyRange.only(bookId)));
  return all
    .filter((s) => s.spineIndex <= furthestSpineIndex)
    .sort((a, b) => a.spineIndex - b.spineIndex);
}

// ---------------------------------------------------------------------
// Chat history (one record per book, holding the full message list)
// ---------------------------------------------------------------------

export async function getChatHistory(bookId) {
  const store = await getStore('chatHistory');
  const record = await promisifyRequest(store.get(bookId));
  return record ? record.messages : [];
}

export async function appendChatMessage(bookId, message) {
  const messages = await getChatHistory(bookId);
  messages.push({ ...message, timestamp: Date.now() });
  const store = await getStore('chatHistory', 'readwrite');
  await promisifyRequest(store.put({ bookId, messages }));
  return messages;
}

// ---------------------------------------------------------------------
// Small helper used by summarizer.js to detect when a chapter's text has
// changed (e.g. the same book re-imported from a different source) so a
// stale cached summary doesn't get served silently.
//
// This is FNV-1a, a fast non-cryptographic hash - plenty for cache
// invalidation, and unlike crypto.subtle.digest() it works even when the
// page isn't served over HTTPS/localhost (useful during LAN dev testing).
// ---------------------------------------------------------------------

export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
