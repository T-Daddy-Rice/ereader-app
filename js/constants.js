// Central place for values you might need to change later (model name, API
// version, etc.) so you don't have to go hunting through every file.

// Anthropic model used for both chat answers and chapter summaries.
// If Anthropic releases a newer model you want to switch to, this is the
// only line you need to change - but also update PRICE_PER_MTOK_INPUT /
// PRICE_PER_MTOK_OUTPUT below, since those are specific to this model and
// drive the cost readout shown in the chat panel.
export const MODEL_ID = 'claude-haiku-4-5-20251001';

// Per-million-token pricing for MODEL_ID above, used only to show an
// approximate cost readout after each chat reply (see estimateCost() in
// claude-api.js). Not pulled from Anthropic's billing API - if you change
// MODEL_ID, update these two numbers to match or the readout will be wrong.
export const PRICE_PER_MTOK_INPUT = 1.0;
export const PRICE_PER_MTOK_OUTPUT = 5.0;

// Anthropic Messages API version header. Check
// https://docs.claude.com/en/api/overview if requests start failing with a
// version-related error - Anthropic occasionally rolls these forward.
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Token budget for chat replies and for chapter summaries. Summaries are
// short by design so they stay cheap to include as context on every message.
export const CHAT_MAX_TOKENS = 1024;
export const SUMMARY_MAX_TOKENS = 512;

// How many prior chat turns (user+assistant pairs) to replay as context on
// each new question, so follow-ups like "what about him?" still work. Kept
// small since this whole history gets resent on every single message.
export const CHAT_HISTORY_TURNS = 6;

// Claude Haiku 4.5's context window is 200,000 tokens total (the prompt
// you send, not counting the reply) - much smaller than Opus's 1M, which
// is why a chat message that used to fit fine can suddenly fail with
// "prompt is too long" after switching models. MAX_CONTEXT_TOKENS is the
// ceiling context-builder.js budgets the current chapter + summaries +
// history under, well below 200,000 so that its character-based token
// estimate (which isn't Anthropic's real tokenizer, just a close
// approximation), the system prompt, and normal variance all have room to
// spare. If you ever change MODEL_ID to a model with a different context
// window, update this to match (keeping a similar safety margin below it).
export const MAX_CONTEXT_TOKENS = 150000;

// Ceiling on how much of a single chapter's text gets sent, so one
// unusually large chapter - or an EPUB that wasn't split into multiple
// files the way most are - can't consume the entire context budget by
// itself and crowd out everything else (or blow the limit on its own).
// Also doubles as the trigger for heading-based chapter splitting (see
// summarizer.js's getChapterSegments()) - a spine item only gets scanned
// for heading tags if its text is bigger than this in the first place.
export const MAX_CHAPTER_TOKENS = 100000;

// When a spine item is oversized (see above), summarizer.js looks for
// heading tags (h1-h6) that mark real chapter breaks inside it - common in
// EPUBs (e.g. from Project Gutenberg) that put the whole book in one file.
// A heading level only counts as a chapter marker if it appears at least
// this many times; otherwise there's nothing to split on and the file is
// truncated as a single oversized chapter instead.
export const MIN_SPLIT_HEADING_COUNT = 2;

// Rough token estimate used for budgeting how much context to send - not
// Anthropic's real tokenizer (that would mean an extra API call before
// every message), but English prose averages close to 4 characters per
// token, which combined with MAX_CONTEXT_TOKENS's safety margin is close
// enough to reliably stay under the model's real context window. Shared
// by context-builder.js (budgeting chat context) and summarizer.js
// (guarding chapter-summary requests against the same oversized-file
// problem).
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// IndexedDB database name/version. Bump DB_VERSION and add an upgrade path
// in db.js if you ever change the object store shapes below.
export const DB_NAME = 'ereader-db';
export const DB_VERSION = 1;

// localStorage key for the Anthropic API key. Never commit an actual key -
// this only names where the browser stores the one you paste into Settings.
export const API_KEY_STORAGE_KEY = 'ereader.anthropicApiKey';
