// Entry point: wires the library, reader, chat, and settings modules
// together and handles switching between the three top-level views.

import { initLibrary, renderLibrary } from './library.js';
import { initReader, openBook } from './reader.js';
import { initChat, onChatDrawerOpened } from './chat.js';
import { initSettings } from './settings.js';

const libraryView = document.getElementById('library-view');
const readerView = document.getElementById('reader-view');
const settingsView = document.getElementById('settings-view');
const settingsButton = document.getElementById('settings-button');

function showView(view) {
  [libraryView, readerView, settingsView].forEach((v) => {
    v.hidden = v !== view;
  });
}

function showLibrary() {
  showView(libraryView);
  renderLibrary();
}

async function showReader(bookId) {
  showView(readerView);
  try {
    await openBook(bookId);
  } catch (error) {
    console.error('Failed to open book', error);
    alert(`Could not open this book.\n\n${error.message}`);
    showLibrary();
  }
}

function showSettings() {
  showView(settingsView);
}

function init() {
  initLibrary({ onOpenBook: showReader });
  initReader({ onBack: showLibrary, onChatToggle: onChatDrawerOpened });
  initChat();
  initSettings({ onBack: showLibrary });

  settingsButton.addEventListener('click', showSettings);

  showLibrary();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((error) => {
      // Not fatal - the app still works, it just won't cache for offline
      // use. Most likely cause during local dev is testing over plain
      // http:// on your LAN, which isn't a secure context (see README).
      console.error('Service worker registration failed', error);
    });
  });
}

init();
