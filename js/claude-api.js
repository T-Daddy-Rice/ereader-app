// Thin wrapper around a direct browser call to the Anthropic Messages API.
//
// This calls api.anthropic.com straight from the browser (no backend
// server exists in this app), which requires the
// `anthropic-dangerous-direct-browser-access` header below. Double check
// that's still the correct header/requirement against
// https://docs.claude.com/en/api/overview if requests start failing -
// Anthropic can change this.

import { MODEL_ID, ANTHROPIC_API_VERSION, ANTHROPIC_API_URL } from './constants.js';
import { getApiKey } from './settings.js';

// `kind` lets callers (chat.js) show a tailored message without having to
// re-parse error text - e.g. "no-key" points the reader at Settings,
// "offline" makes clear reading still works even though chat doesn't.
export class ClaudeApiError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'ClaudeApiError';
    this.kind = kind;
  }
}

export async function sendMessage({ system, messages, maxTokens }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new ClaudeApiError('No Anthropic API key set yet. Add one in Settings.', 'no-key');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ClaudeApiError(
      "You're offline. Reading still works, but chat needs a connection.",
      'offline'
    );
  }

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });
  } catch (networkError) {
    throw new ClaudeApiError(
      "Couldn't reach Anthropic. Check your connection and try again.",
      'offline'
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ClaudeApiError(
        'Anthropic rejected the API key. Double-check it in Settings.',
        'unauthorized'
      );
    }
    if (response.status === 429) {
      throw new ClaudeApiError('Rate limited by Anthropic. Try again in a moment.', 'rate-limit');
    }
    if (response.status >= 500) {
      throw new ClaudeApiError("Anthropic's API is having trouble. Try again shortly.", 'server');
    }
    const bodyText = await response.text().catch(() => '');
    throw new ClaudeApiError(
      `Anthropic API error (${response.status}): ${bodyText.slice(0, 200)}`,
      'unknown'
    );
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((block) => block.type === 'text');
  return textBlock ? textBlock.text : '';
}
