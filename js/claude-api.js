// Thin wrapper around a direct browser call to the Anthropic Messages API.
//
// This calls api.anthropic.com straight from the browser (no backend
// server exists in this app), which requires the
// `anthropic-dangerous-direct-browser-access` header below. Double check
// that's still the correct header/requirement against
// https://docs.claude.com/en/api/overview if requests start failing -
// Anthropic can change this.

import {
  MODEL_ID,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_API_URL,
  PRICE_PER_MTOK_INPUT,
  PRICE_PER_MTOK_OUTPUT,
} from './constants.js';
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

// `cache: true` marks the request for Anthropic's prompt caching - it
// writes (or reuses) a cached copy of the request's shared prefix (the
// system prompt + the stable early messages, e.g. the current chapter's
// text) so that asking a second question about the same chapter re-reads
// that chunk at ~10% of its normal price instead of paying full price
// again. Only worth it for repeat-message conversations (chat), not
// one-shot calls (chapter summaries) that are never sent again - so
// summarizer.js leaves this off and chat.js turns it on.
export async function sendMessage({ system, messages, maxTokens, cache = false }) {
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
        // Auto-places the cache breakpoint on the last cacheable block of
        // the request - simplest option, and fine here since we don't
        // need finer-grained placement than "cache everything sent so far".
        ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
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
  return { text: textBlock ? textBlock.text : '', usage: data.usage || null };
}

// Rough dollar cost of one API call, from the `usage` object sendMessage()
// returns. This is an estimate for display only (e.g. the chat panel's
// per-reply cost readout) - it's computed from MODEL_ID's per-token prices
// in constants.js, not pulled from Anthropic's actual billing, so treat it
// as "about how much," not an exact invoice line.
export function estimateCost(usage) {
  if (!usage) return null;

  const inputTokens = usage.input_tokens || 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  // Cache writes cost ~1.25x normal input price, cache reads ~0.1x. This
  // app doesn't currently use prompt caching, so those two are normally 0.
  const cost =
    (inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT +
    (cacheWriteTokens / 1_000_000) * PRICE_PER_MTOK_INPUT * 1.25 +
    (cacheReadTokens / 1_000_000) * PRICE_PER_MTOK_INPUT * 0.1 +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT;

  return {
    totalTokens: inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    cost,
  };
}
