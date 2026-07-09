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
import { CHAT_HISTORY_TURNS, MAX_CONTEXT_TOKENS, MAX_CHAPTER_TOKENS } from './constants.js';

// Rough token estimate used only for budgeting how much context to send -
// not Anthropic's real tokenizer (that would mean an extra API call before
// every message), but English prose averages close to 4 characters per
// token, which combined with MAX_CONTEXT_TOKENS's safety margin is close
// enough to reliably stay under the model's real context window.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

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

  let currentChapterText = await getChapterText(book, currentSpineIndex);
  let chapterTruncated = false;
  if (estimateTokens(currentChapterText) > MAX_CHAPTER_TOKENS) {
    // Either a genuinely huge chapter, or (more likely) an EPUB that
    // wasn't split into multiple spine items the way most are - e.g. the
    // whole book in one file. Truncate rather than blow the model's
    // context window; the note below tells the AI (so it doesn't imply
    // it read the whole thing) that this happened.
    currentChapterText = currentChapterText.slice(0, MAX_CHAPTER_TOKENS * 4);
    chapterTruncated = true;
  }

  // Budget what's left for summaries + chat history, leaving slack for
  // the system prompt and the wrapper text assembled below.
  let remainingBudget = MAX_CONTEXT_TOKENS - estimateTokens(currentChapterText) - 1000;

  const allSummaries = (await getSummariesUpTo(bookId, furthestSpineIndex)).filter(
    (summary) => summary.spineIndex !== currentSpineIndex && summary.summaryText
  );

  // Prefer the most recently read chapters' summaries when there isn't
  // room for all of them - they're the most likely to matter for whatever
  // the reader's asking about right now. Walk newest-to-oldest and stop
  // once one doesn't fit; everything before that point is even older, so
  // there's no reason to keep checking further back.
  const includedSummaries = [];
  let summariesOmitted = false;
  for (let i = allSummaries.length - 1; i >= 0; i--) {
    const summary = allSummaries[i];
    const line = `Chapter ${summary.spineIndex + 1} summary: ${summary.summaryText}`;
    const lineTokens = estimateTokens(line);
    if (lineTokens > remainingBudget) {
      summariesOmitted = true;
      break;
    }
    includedSummaries.push(line);
    remainingBudget -= lineTokens;
  }
  includedSummaries.reverse(); // back to chapter order
  const priorSummaries = includedSummaries.join('\n\n');

  const contextPreamble = [
    priorSummaries
      ? `Summaries of chapters read so far:\n\n${priorSummaries}${
          summariesOmitted
            ? '\n\n[Some earlier chapter summaries were left out to fit this conversation - treat those chapters as unknown rather than assuming nothing happened in them.]'
            : ''
        }`
      : "This is the first chapter - there's nothing prior to summarize yet.",
    `Full text of the current chapter (chapter ${currentSpineIndex + 1}):\n\n${currentChapterText}${
      chapterTruncated
        ? '\n\n[This chapter is very long and was cut off here to fit - treat anything after this point as unknown rather than assuming it matches the rest.]'
        : ''
    }`,
  ].join('\n\n---\n\n');

  const messages = [
    { role: 'user', content: `Book material available to you for this conversation:\n\n${contextPreamble}` },
    {
      role: 'assistant',
      content:
        "Understood - I'll only use this chapter's text and the summaries of chapters already read, " +
        "and won't reference anything beyond where you've currently read.",
    },
    ...(await recentAlternatingHistory(bookId, remainingBudget)),
  ];

  return { system: SYSTEM_PROMPT, messages };
}

// Returns the last CHAT_HISTORY_TURNS*2 messages, trimmed further (oldest
// first) if they don't fit tokenBudget, and trimmed at the front so the
// result still starts with a 'user' message - the Anthropic API requires
// the first message in a conversation to be from the user.
async function recentAlternatingHistory(bookId, tokenBudget) {
  const history = await getChatHistory(bookId);
  let recent = history.slice(-CHAT_HISTORY_TURNS * 2);

  let used = recent.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  while (used > tokenBudget && recent.length > 0) {
    const dropped = recent.shift();
    used -= estimateTokens(dropped.content);
  }

  while (recent.length && recent[0].role !== 'user') {
    recent = recent.slice(1);
  }

  return recent.map((message) => ({ role: message.role, content: message.content }));
}
