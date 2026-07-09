// Library view: importing EPUB files, listing books, deleting books.
//
// `ePub` here is a global provided by vendor/epub.min.js (loaded as a
// plain <script> before this module, see index.html) - that's why there's
// no `import` for it despite this file being an ES module.

import { addBook, getAllBooks, deleteBook } from './db.js';

const fileInput = document.getElementById('epub-file-input');
const bookGrid = document.getElementById('book-grid');
const emptyMessage = document.getElementById('library-empty-message');

// Object URLs we've handed to <img> tags for covers. Revoked and rebuilt
// on every render so we don't leak memory as books get added/removed.
let activeCoverUrls = [];

let openBookCallback = null;

export function initLibrary({ onOpenBook }) {
  openBookCallback = onOpenBook;
  fileInput.addEventListener('change', handleFileSelected);
  renderLibrary();
}

async function handleFileSelected(event) {
  const file = event.target.files[0];
  fileInput.value = ''; // allow re-selecting the same file later
  if (!file) return;

  try {
    await importEpubFile(file);
    await renderLibrary();
  } catch (error) {
    console.error('Failed to import EPUB', error);
    alert(`Could not import "${file.name}". Is it a valid EPUB file?\n\n${error.message}`);
  }
}

async function importEpubFile(file) {
  const arrayBuffer = await file.arrayBuffer();

  // Parse just enough to pull out title/author/cover for the library card.
  // reader.js does its own, separate ePub() parse when actually opening
  // the book to read - the two never share a Book instance.
  const book = ePub(arrayBuffer);
  await book.ready;
  const metadata = await book.loaded.metadata;

  let coverBlob = null;
  const coverUrl = await book.coverUrl();
  if (coverUrl) {
    const response = await fetch(coverUrl);
    coverBlob = await response.blob();
  }
  book.destroy();

  const fileBlob = new Blob([arrayBuffer], { type: 'application/epub+zip' });

  return addBook({
    title: metadata.title || file.name.replace(/\.epub$/i, ''),
    author: metadata.creator,
    coverBlob,
    fileBlob,
  });
}

export async function renderLibrary() {
  activeCoverUrls.forEach((url) => URL.revokeObjectURL(url));
  activeCoverUrls = [];

  const books = await getAllBooks();
  emptyMessage.hidden = books.length > 0;
  bookGrid.innerHTML = '';

  for (const book of books) {
    bookGrid.appendChild(renderBookCard(book));
  }
}

function renderBookCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';

  const cover = document.createElement('div');
  cover.className = 'book-cover';
  if (book.coverBlob) {
    const url = URL.createObjectURL(book.coverBlob);
    activeCoverUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    cover.appendChild(img);
  } else {
    cover.classList.add('book-cover-placeholder');
    cover.textContent = (book.title || '?').charAt(0).toUpperCase();
  }
  cover.addEventListener('click', () => openBookCallback && openBookCallback(book.id));

  const title = document.createElement('div');
  title.className = 'book-title';
  title.textContent = book.title;

  const author = document.createElement('div');
  author.className = 'book-author';
  author.textContent = book.author || '';

  const deleteButton = document.createElement('button');
  deleteButton.className = 'book-delete-button';
  deleteButton.setAttribute('aria-label', `Delete ${book.title}`);
  deleteButton.textContent = '✕';
  deleteButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (confirm(`Delete "${book.title}"? This removes it and all reading progress/chat history.`)) {
      await deleteBook(book.id);
      await renderLibrary();
    }
  });

  card.append(cover, title, author, deleteButton);
  return card;
}
