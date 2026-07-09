// The AI reading-companion chat drawer: freeform Q&A about the book,
// answered using only material up to the reader's current position (see
// context-builder.js for how that boundary is enforced).

import { getReaderState } from './reader.js';
import { getChatHistory, appendChatMessage } from './db.js';
import { buildChatRequest } from './context-builder.js';
import { sendMessage, ClaudeApiError } from './claude-api.js';
import { CHAT_MAX_TOKENS } from './constants.js';

const messagesEl = document.getElementById('chat-messages');
const statusEl = document.getElementById('chat-status');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('chat-input');
const sendButton = document.getElementById('chat-send-button');

let loadedBookId = null;
let isSending = false;

export function initChat() {
  formEl.addEventListener('submit', handleSubmit);

  // Enter sends the question; Shift+Enter inserts a newline, matching
  // common chat-app convention.
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });
  inputEl.addEventListener('input', autoResizeInput);
}

// Called by reader.js whenever the chat drawer is opened, so the thread
// shown always matches whichever book is currently open.
export async function onChatDrawerOpened() {
  const readerState = getReaderState();
  if (!readerState) return;
  if (readerState.bookId === loadedBookId) return; // already showing this book's history
  loadedBookId = readerState.bookId;
  await renderHistory(readerState.bookId);
}

async function renderHistory(bookId) {
  messagesEl.innerHTML = '';
  const history = await getChatHistory(bookId);
  history.forEach((message) => appendBubble(message.role, message.content));
  scrollToBottom();
}

async function handleSubmit(event) {
  event.preventDefault();
  if (isSending) return;

  const readerState = getReaderState();
  if (!readerState) return;

  const question = inputEl.value.trim();
  if (!question) return;

  inputEl.value = '';
  autoResizeInput();
  setSending(true);
  hideStatus();

  appendBubble('user', question);
  await appendChatMessage(readerState.bookId, { role: 'user', content: question });

  const thinkingBubble = appendBubble('assistant', '…', { pending: true });

  try {
    const { system, messages } = await buildChatRequest(readerState);
    const answer = await sendMessage({ system, messages, maxTokens: CHAT_MAX_TOKENS });
    thinkingBubble.querySelector('.chat-bubble-text').textContent = answer;
    thinkingBubble.classList.remove('chat-bubble-pending');
    await appendChatMessage(readerState.bookId, { role: 'assistant', content: answer });
  } catch (error) {
    thinkingBubble.remove();
    showError(error);
  } finally {
    setSending(false);
    scrollToBottom();
  }
}

function appendBubble(role, text, { pending = false } = {}) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble-${role}${pending ? ' chat-bubble-pending' : ''}`;

  const textEl = document.createElement('div');
  textEl.className = 'chat-bubble-text';
  textEl.textContent = text;

  bubble.appendChild(textEl);
  messagesEl.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

function showError(error) {
  const isKnownError = error instanceof ClaudeApiError;
  statusEl.textContent = isKnownError ? error.message : `Something went wrong: ${error.message}`;
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

function setSending(sending) {
  isSending = sending;
  sendButton.disabled = sending;
  inputEl.disabled = sending;
}

function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
