// Central place for values you might need to change later (model name, API
// version, etc.) so you don't have to go hunting through every file.

// Anthropic model used for both chat answers and chapter summaries.
// If Anthropic releases a newer model you want to switch to, this is the
// only line you need to change.
export const MODEL_ID = 'claude-opus-4-8';

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
// each new question, so follow-ups like "what about him?" still work.
export const CHAT_HISTORY_TURNS = 10;

// IndexedDB database name/version. Bump DB_VERSION and add an upgrade path
// in db.js if you ever change the object store shapes below.
export const DB_NAME = 'ereader-db';
export const DB_VERSION = 1;

// localStorage key for the Anthropic API key. Never commit an actual key -
// this only names where the browser stores the one you paste into Settings.
export const API_KEY_STORAGE_KEY = 'ereader.anthropicApiKey';
