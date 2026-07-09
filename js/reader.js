// The reader view: renders an EPUB with epub.js, tracks reading position,
// and exposes that position so chat.js / context-builder.js can build a
// no-spoiler context for the AI companion.
//
// `ePub` is a global from vendor/epub.min.js (see index.html); no import
// needed for it.

import { getBook, getProgress, updateProgress, addBookmark, getBookmarks, deleteBookmark } from './db.js';
import { ensureSummariesUpTo } from './summarizer.js';

const viewerEl = document.getElementById('viewer');
const readerTitleEl = document.getElementById('reader-title');
const backButton = document.getElementById('back-to-library-button');
const bookmarkButton = document.getElementById('bookmark-button');
const tocButton = document.getElementById('toc-button');
const displaySettingsButton = document.getElementById('display-settings-button');
const chatToggleButton = document.getElementById('chat-toggle-button');
const pageTurnOverlay = document.getElementById('page-turn-overlay');

const tocPanel = document.getElementById('toc-panel');
const tocList = document.getElementById('toc-list');
const bookmarkList = document.getElementById('bookmark-list');
const tocTabContents = document.getElementById('toc-tab-contents');
const tocTabBookmarks = document.getElementById('toc-tab-bookmarks');

const displaySettingsPanel = document.getElementById('display-settings-panel');
const fontSizeValue = document.getElementById('font-size-value');
const fontSizeDecrease = document.getElementById('font-size-decrease');
const fontSizeIncrease = document.getElementById('font-size-increase');
const fontSerifButton = document.getElementById('font-serif');
const fontSansButton = document.getElementById('font-sans');
const themeButtons = {
  light: document.getElementById('theme-light'),
  sepia: document.getElementById('theme-sepia'),
  dark: document.getElementById('theme-dark'),
};

const chatDrawer = document.getElementById('chat-drawer');

const ALL_PANELS = [tocPanel, displaySettingsPanel, chatDrawer];

const DISPLAY_SETTINGS_KEY = 'ereader.displaySettings';
const DEFAULT_DISPLAY_SETTINGS = { fontSizePercent: 100, fontFamily: 'serif', theme: 'light' };

const READING_THEMES = {
  light: { body: { background: '#ffffff', color: '#1c1c1e' } },
  sepia: { body: { background: '#f4ecd8', color: '#5b4636' } },
  dark: { body: { background: '#1c1c1e', color: '#d8d8dc' } },
};

let book = null;
let rendition = null;
let currentBookId = null;
let currentProgress = null;
let backCallback = null;
let onChatToggle = null;
let displaySettings = loadDisplaySettings();

function loadDisplaySettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || '{}');
    return { ...DEFAULT_DISPLAY_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_DISPLAY_SETTINGS };
  }
}

function saveDisplaySettings() {
  localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(displaySettings));
}

// ---------------------------------------------------------------------
// Setup (called once at app startup)
// ---------------------------------------------------------------------

export function initReader({ onBack, onChatToggle: onChatToggleCallback }) {
  backCallback = onBack;
  onChatToggle = onChatToggleCallback;

  backButton.addEventListener('click', () => {
    closeBook();
    backCallback && backCallback();
  });

  tocButton.addEventListener('click', () => togglePanel(tocPanel));
  displaySettingsButton.addEventListener('click', () => togglePanel(displaySettingsPanel));
  chatToggleButton.addEventListener('click', () => {
    togglePanel(chatDrawer);
    if (!chatDrawer.hidden) onChatToggle && onChatToggle();
  });

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.close).hidden = true;
    });
  });

  tocTabContents.addEventListener('click', () => switchTocTab('contents'));
  tocTabBookmarks.addEventListener('click', () => switchTocTab('bookmarks'));

  bookmarkButton.addEventListener('click', toggleBookmarkAtCurrentPosition);

  initPageTurnOverlay();

  document.addEventListener('keydown', (event) => {
    if (!rendition || document.getElementById('reader-view').hidden) return;
    if (event.key === 'ArrowLeft') rendition.prev();
    if (event.key === 'ArrowRight') rendition.next();
  });

  fontSizeDecrease.addEventListener('click', () => adjustFontSize(-10));
  fontSizeIncrease.addEventListener('click', () => adjustFontSize(10));
  fontSerifButton.addEventListener('click', () => setFontFamily('serif'));
  fontSansButton.addEventListener('click', () => setFontFamily('sans'));
  Object.entries(themeButtons).forEach(([name, button]) => {
    button.addEventListener('click', () => setTheme(name));
  });

  updateDisplaySettingsUI();
}

// Page turns (tap edges + swipe anywhere), handled entirely in this page
// rather than inside the book's iframe. epub.js renders each chapter into
// a sandboxed iframe, and touch events inside it aren't reliably delivered
// on iOS Safari - this overlay sits above that iframe in the main document
// instead, where touch handling is unremarkable.
function initPageTurnOverlay() {
  const EDGE_FRACTION = 0.18; // tap within this fraction of either edge = page turn
  const SWIPE_THRESHOLD_PX = 40;
  const SWIPE_MAX_VERTICAL_PX = 60;
  const SWIPE_MAX_DURATION_MS = 600;

  pageTurnOverlay.addEventListener('click', (event) => {
    if (!rendition) return;
    const rect = pageTurnOverlay.getBoundingClientRect();
    const relativeX = (event.clientX - rect.left) / rect.width;
    if (relativeX <= EDGE_FRACTION) rendition.prev();
    else if (relativeX >= 1 - EDGE_FRACTION) rendition.next();
  });

  let touchStartX = null;
  let touchStartY = null;
  let touchStartTime = 0;

  pageTurnOverlay.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.changedTouches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
    },
    { passive: true }
  );

  pageTurnOverlay.addEventListener(
    'touchend',
    (event) => {
      if (touchStartX === null || !rendition) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      const dt = Date.now() - touchStartTime;
      touchStartX = null;

      const isHorizontalSwipe =
        Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dy) < SWIPE_MAX_VERTICAL_PX && dt < SWIPE_MAX_DURATION_MS;
      if (!isHorizontalSwipe) return;

      if (dx < 0) rendition.next();
      else rendition.prev();
    },
    { passive: true }
  );
}

function togglePanel(panel) {
  const isOpening = panel.hidden;
  ALL_PANELS.forEach((p) => {
    p.hidden = true;
  });
  panel.hidden = !isOpening;
}

function closeAllPanels() {
  ALL_PANELS.forEach((p) => {
    p.hidden = true;
  });
}

function switchTocTab(tab) {
  const showContents = tab === 'contents';
  tocList.hidden = !showContents;
  bookmarkList.hidden = showContents;
  tocTabContents.classList.toggle('panel-tab-active', showContents);
  tocTabBookmarks.classList.toggle('panel-tab-active', !showContents);
}

// ---------------------------------------------------------------------
// Opening / closing a book
// ---------------------------------------------------------------------

export async function openBook(bookId) {
  closeBook();

  const record = await getBook(bookId);
  if (!record) throw new Error('Book not found in library');

  currentBookId = bookId;
  readerTitleEl.textContent = record.title;

  const arrayBuffer = await record.fileBlob.arrayBuffer();
  book = ePub(arrayBuffer);
  await book.ready;

  rendition = book.renderTo('viewer', {
    width: '100%',
    height: '100%',
    flow: 'paginated',
    spread: 'auto',
    // The default manager only handles clicks/keyboard. The continuous
    // manager has epub.js's built-in touch-swipe ("snap to page") support -
    // still shows one page at a time since flow is 'paginated', but swiping
    // actually turns pages on touch devices this way.
    manager: 'continuous',
  });

  registerReadingThemes();
  applyDisplaySettingsToRendition();

  currentProgress = await getProgress(bookId);
  await rendition.display(currentProgress.currentCfi || undefined);

  rendition.on('relocated', handleRelocated);

  await buildTocList();
  await refreshBookmarkList();
  updateBookmarkButtonState();
}

export function closeBook() {
  closeAllPanels();
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  if (book) {
    book.destroy();
    book = null;
  }
  currentBookId = null;
  currentProgress = null;
  viewerEl.innerHTML = '';
  tocList.innerHTML = '';
  bookmarkList.innerHTML = '';
}

// Read by chat.js / context-builder.js to know what book/position to build
// no-spoiler context around. Returns null if no book is currently open.
export function getReaderState() {
  if (!currentBookId || !currentProgress) return null;
  return {
    book,
    bookId: currentBookId,
    currentSpineIndex: currentProgress.currentSpineIndex,
    furthestSpineIndex: currentProgress.furthestSpineIndex,
  };
}

// ---------------------------------------------------------------------
// Position tracking + lazy summary generation
// ---------------------------------------------------------------------

function handleRelocated(location) {
  const spineIndex = location.start.index;
  const cfi = location.start.cfi;
  const wasFurthest = currentProgress.furthestSpineIndex || 0;
  const isNewFurthest = spineIndex > wasFurthest;

  const updates = { currentCfi: cfi, currentSpineIndex: spineIndex };
  if (isNewFurthest) updates.furthestSpineIndex = spineIndex;

  updateProgress(currentBookId, updates).then((saved) => {
    currentProgress = saved;
    if (isNewFurthest) {
      // Fire-and-forget: summarize newly-reached chapters in the
      // background so they're ready by the time chat needs them. Any
      // failure here (e.g. no API key yet) is just logged - it isn't the
      // reader's job to surface API errors, only chat's.
      ensureSummariesUpTo(book, currentBookId, saved.furthestSpineIndex).catch((error) => {
        console.error('Background chapter summarization failed', error);
      });
    }
  });

  updateBookmarkButtonState();
}

// ---------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------

async function buildTocList() {
  tocList.innerHTML = '';
  const navigation = await book.loaded.navigation;
  renderTocItems(navigation.toc, tocList, 0);
}

function renderTocItems(items, container, depth) {
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item.label.trim();
    li.style.paddingLeft = `${8 + depth * 16}px`;
    li.addEventListener('click', () => {
      safeDisplay(item.href, item.label.trim());
      togglePanel(tocPanel);
      tocPanel.hidden = true;
    });
    container.appendChild(li);
    if (item.subitems && item.subitems.length) {
      renderTocItems(item.subitems, container, depth + 1);
    }
  }
}

// epub.js's rendition.display(target) resolves `target` via
// book.spine.get(target) internally, and on some books the table-of-
// contents/nav document's hrefs don't exactly match how epub.js indexes
// spine items (this has been observed to differ between browser engines).
// When that lookup fails, letting epub.js proceed anyway risks it trying
// to resolve the target as a real network request - which, on a project
// site like GitHub Pages, can 404 all the way out to the bare domain root.
// Validate the target resolves to a real chapter first and refuse to
// navigate otherwise, so a bad link fails quietly instead of leaving the
// app entirely.
function safeDisplay(target, label) {
  const section = book.spine.get(target);
  if (!section) {
    console.error(`No chapter found for "${label}" (target: ${target}) - refusing to navigate`);
    alert(`Couldn't open "${label}" - this link doesn't match a chapter in this book.`);
    return;
  }
  rendition.display(target);
}

// ---------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------

async function refreshBookmarkList() {
  bookmarkList.innerHTML = '';
  const bookmarks = await getBookmarks(currentBookId);
  for (const bookmark of bookmarks) {
    const li = document.createElement('li');
    li.textContent = bookmark.label || 'Bookmark';
    li.addEventListener('click', () => {
      safeDisplay(bookmark.cfi, bookmark.label || 'Bookmark');
      tocPanel.hidden = true;
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'icon-button';
    deleteButton.textContent = '✕';
    deleteButton.setAttribute('aria-label', 'Delete bookmark');
    deleteButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deleteBookmark(bookmark.id);
      await refreshBookmarkList();
      updateBookmarkButtonState();
    });

    li.appendChild(deleteButton);
    bookmarkList.appendChild(li);
  }
}

async function toggleBookmarkAtCurrentPosition() {
  if (!currentProgress || !currentProgress.currentCfi) return;
  const bookmarks = await getBookmarks(currentBookId);
  const existing = bookmarks.find((b) => b.cfi === currentProgress.currentCfi);

  if (existing) {
    await deleteBookmark(existing.id);
  } else {
    const label = await currentLocationLabel();
    await addBookmark(currentBookId, currentProgress.currentCfi, label);
  }
  await refreshBookmarkList();
  updateBookmarkButtonState();
}

async function currentLocationLabel() {
  try {
    const navigation = await book.loaded.navigation;
    const spineItem = book.spine.get(currentProgress.currentSpineIndex);
    const match = navigation.toc.find((item) => book.spine.get(item.href)?.index === spineItem.index);
    return match ? match.label.trim() : `Location ${currentProgress.currentSpineIndex + 1}`;
  } catch {
    return `Location ${currentProgress.currentSpineIndex + 1}`;
  }
}

async function updateBookmarkButtonState() {
  if (!currentProgress || !currentProgress.currentCfi) {
    bookmarkButton.textContent = '♡';
    return;
  }
  const bookmarks = await getBookmarks(currentBookId);
  const isBookmarked = bookmarks.some((b) => b.cfi === currentProgress.currentCfi);
  bookmarkButton.textContent = isBookmarked ? '♥' : '♡';
}

// ---------------------------------------------------------------------
// Display settings (font size, typeface, reading theme)
// ---------------------------------------------------------------------

function registerReadingThemes() {
  Object.entries(READING_THEMES).forEach(([name, styles]) => {
    rendition.themes.register(name, styles);
  });
}

function applyDisplaySettingsToRendition() {
  if (!rendition) return;
  rendition.themes.select(displaySettings.theme);
  rendition.themes.fontSize(`${displaySettings.fontSizePercent}%`);
  rendition.themes.font(displaySettings.fontFamily === 'serif' ? 'serif' : 'sans-serif');
}

function updateDisplaySettingsUI() {
  fontSizeValue.textContent = `${displaySettings.fontSizePercent}%`;
  fontSerifButton.classList.toggle('pill-button-active', displaySettings.fontFamily === 'serif');
  fontSansButton.classList.toggle('pill-button-active', displaySettings.fontFamily === 'sans');
  Object.entries(themeButtons).forEach(([name, button]) => {
    button.classList.toggle('pill-button-active', displaySettings.theme === name);
  });
}

function adjustFontSize(deltaPercent) {
  const next = displaySettings.fontSizePercent + deltaPercent;
  displaySettings.fontSizePercent = Math.min(200, Math.max(60, next));
  saveDisplaySettings();
  updateDisplaySettingsUI();
  applyDisplaySettingsToRendition();
}

function setFontFamily(fontFamily) {
  displaySettings.fontFamily = fontFamily;
  saveDisplaySettings();
  updateDisplaySettingsUI();
  applyDisplaySettingsToRendition();
}

function setTheme(theme) {
  displaySettings.theme = theme;
  saveDisplaySettings();
  updateDisplaySettingsUI();
  applyDisplaySettingsToRendition();
}

