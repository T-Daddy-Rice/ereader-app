// Settings view: paste-once Anthropic API key, stored only in
// localStorage (never sent anywhere but directly to Anthropic's API, and
// never written into any file that could end up committed to git).

import { API_KEY_STORAGE_KEY } from './constants.js';

const form = document.getElementById('api-key-form');
const input = document.getElementById('api-key-input');
const status = document.getElementById('api-key-status');
const backButton = document.getElementById('settings-back-button');

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
}

function setApiKey(key) {
  if (key) {
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
}

export function initSettings({ onBack }) {
  input.value = getApiKey();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const key = input.value.trim();
    setApiKey(key);
    status.textContent = key ? 'Key saved.' : 'Key cleared.';
    status.hidden = false;
    setTimeout(() => {
      status.hidden = true;
    }, 2000);
  });

  backButton.addEventListener('click', () => onBack && onBack());
}
