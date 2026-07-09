// Assembles the no-spoiler context sent to the Claude API for a chat
// message: the full text of the reader's current chapter, cached
// summaries of every chapter up to the furthest one they've ever reached,
// recent chat history for this book, and a system prompt spelling out the
// no-spoiler rule.
//
// This module is the one place responsible for the spoiler boundary: it
// only ever reads chapters at index <= furthestSpineIndex. Nothing beyond
// that is loaded, hashed, summarized, or sent - so the rule is enforced
// structurally, not just by asking the model nicely in the system prompt
// (though we do that too, as a second layer).

import { getSummariesUpTo, getChatHistory } from './db.js';
import { getChapterText, ensureSummaryForChapter } from './summarizer.js';
import { CHAT_HISTORY_TURNS } from './constants.js';

const SYSTEM_PROMPT = [
  "You are a reading companion built into the reader's personal e-reader app.",
  "Answer questions about the book using ONLY the material provided in this conversation: " +
    'summaries of chapters already read, and the full text of the current chapter.',
  'CRITICAL RULE: never reveal, hint at, or reference any plot point, character fate, or detail ' +
    "that only appears later in the book, beyond what's provided below. If asked about something " +
    "that would require reading ahead, say you can't discuss that yet without spoiling it.",
  'Do not rely on any outside knowledge you might have about this book (e.g. from training data) - ' +
    'use only the text given here. The reader may be on a different edition or translation, and ' +
    'outside knowledge risks spoilers this app is specifically designed to prevent.',
].join(' ');

// `readerState` is whatever reader.js's getReaderState() returns:
// { book, bookId, currentSpineIndex, furthestSpineIndex }.
export async function buildChatRequest(readerState) {
  const { book, bookId, currentSpineIndex, furthestSpineIndex } = readerState;

  // Defensive catch-up: reader.js already triggers this in the background
  // on page turns, but if the reader opens chat before that's finished
  // (or right after opening a book with unsummarized chapters already
  // behind them), make sure nothing's missing before we build context.
  //
  // A failure summarizing one prior chapter (bad key, rate limit, network
  // blip) shouldn't block answering a question about the CURRENT chapter -
  // that chapter's summary is just skipped from context this time, and
  // will be retried the next time it's needed. Same tolerance reader.js
  // already applies to its own background summarization pass.
  for (let spineIndex = 0; spineIndex <= furthestSpineIndex; spineIndex++) {
    if (spineIndex === currentSpineIndex) continue; // gets full text instead, below
    try {
      await ensureSummaryForChapter(book, bookId, spineIndex);
    } catch (error) {
      console.error(`Could not summarize chapter ${spineIndex + 1}, skipping it for this context`, error);
    }
  }

  const currentChapterText = await getChapterText(book, currentSpineIndex);

  const priorSummaries = (await getSummariesUpTo(bookId, furthestSpineIndex))
    .filter((summary) => summary.spineIndex !== currentSpineIndex && summary.summaryText)
    .map((summary) => `Chapter ${summary.spineIndex + 1} summary: ${summary.summaryText}`)
    .join('\n\n');

  const contextPreamble = [
    priorSummaries
      ? `Summaries of chapters read so far:\n\n${priorSummaries}`
      : "This is the first chapter - there's nothing prior to summarize yet.",
    `Full text of the current chapter (chapter ${currentSpineIndex + 1}):\n\n${currentChapterText}`,
  ].join('\n\n---\n\n');

  const messages = [
    { role: 'user', content: `Book material available to you for this conversation:\n\n${contextPreamble}` },
    {
      role: 'assistant',
      content:
        "Understood - I'll only use this chapter's text and the summaries of chapters already read, " +
        "and won't reference anything beyond where you've currently read.",
    },
    ...(await recentAlternatingHistory(bookId)),
  ];

  return { system: SYSTEM_PROMPT, messages };
}

// Returns the last CHAT_HISTORY_TURNS*2 messages, trimmed at the front if
// needed so the slice still starts with a 'user' message - the Anthropic
// API requires messages to strictly alternate user/assistant.
async function recentAlternatingHistory(bookId) {
  const history = await getChatHistory(bookId);
  let recent = history.slice(-CHAT_HISTORY_TURNS * 2);
  if (recent.length && recent[0].role !== 'user') {
    recent = recent.slice(1);
  }
  return recent.map((message) => ({ role: message.role, content: message.content }));
}
