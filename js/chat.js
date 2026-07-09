// The AI reading-companion chat drawer: freeform Q&A about the book,
// answered using only material up to the reader's current position (see
// context-builder.js for how that boundary is enforced).

import { getReaderState } from './reader.js';
import { getChatHistory, appendChatMessage } from './db.js';
import { buildChatRequest } from './context-builder.js';
import { sendMessage, estimateCost, ClaudeApiError } from './claude-api.js';
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
    const { text: answer, usage } = await sendMessage({ system, messages, maxTokens: CHAT_MAX_TOKENS });
    thinkingBubble.querySelector('.chat-bubble-text').textContent = answer;
    thinkingBubble.classList.remove('chat-bubble-pending');
    collapseIfLong(thinkingBubble);
    appendCostMeta(thinkingBubble, usage);
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
  if (!pending) collapseIfLong(bubble);
  scrollToBottom();
  return bubble;
}

// Shows "N tokens · $0.00XX" under a fresh assistant reply, so it's clear
// what each question actually costs. This is a live-only readout - it's not
// saved to chat history, so it disappears if you reopen the chat drawer
// later (the cost was real either way, just not worth persisting for).
function appendCostMeta(bubble, usage) {
  const cost = estimateCost(usage);
  if (!cost) return;

  const metaEl = document.createElement('div');
  metaEl.className = 'chat-bubble-meta';
  metaEl.textContent = `${cost.totalTokens.toLocaleString()} tokens · $${cost.cost.toFixed(4)}`;
  bubble.appendChild(metaEl);
}

// Long AI answers start collapsed with a "Show more" toggle, so a wall of
// text doesn't push the input off-screen or bury earlier messages.
const COLLAPSE_HEIGHT_PX = 160;

function collapseIfLong(bubble) {
  const textEl = bubble.querySelector('.chat-bubble-text');
  requestAnimationFrame(() => {
    if (textEl.scrollHeight <= COLLAPSE_HEIGHT_PX + 4) return;
    bubble.classList.add('chat-bubble-collapsed');
    if (bubble.querySelector('.chat-bubble-toggle')) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chat-bubble-toggle';
    toggle.textContent = 'Show more';
    toggle.addEventListener('click', () => {
      const collapsed = bubble.classList.toggle('chat-bubble-collapsed');
      toggle.textContent = collapsed ? 'Show more' : 'Show less';
    });
    bubble.appendChild(toggle);
  });
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
