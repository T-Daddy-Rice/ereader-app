// Lazily generates and caches per-chapter summaries, used by
// context-builder.js to give the AI companion a compact view of
// everything before the reader's current chapter (instead of sending the
// full text of every prior chapter on every chat message).
//
// "Chapter" here means one epub.js spine item - the unit epub.js already
// splits the book into. That doesn't always line up perfectly with the
// author's own chapter breaks (a chapter can span multiple spine items in
// some EPUBs), but it's a consistent, simple boundary to key everything
// off of.

import { getSummary, saveSummary, hashText } from './db.js';
import { sendMessage } from './claude-api.js';
import { SUMMARY_MAX_TOKENS } from './constants.js';

// Spine items shorter than this are things like cover/title pages with no
// real content worth summarizing - we cache an empty summary for them so
// we don't keep re-checking (and re-loading their section) every time.
const MIN_CHAPTER_TEXT_LENGTH = 40;

export async function getChapterText(book, spineIndex) {
  const section = book.spine.get(spineIndex);
  if (!section) return '';

  const contents = await section.load(book.load.bind(book));
  const text = (contents.textContent || '').replace(/\s+/g, ' ').trim();
  section.unload();
  return text;
}

// Ensures every chapter from 0 to furthestSpineIndex (inclusive) has a
// cached summary, generating any that are missing. Called in the
// background as the reader turns pages, and again defensively before
// assembling chat context in case the background pass hasn't caught up.
export async function ensureSummariesUpTo(book, bookId, furthestSpineIndex) {
  for (let spineIndex = 0; spineIndex <= furthestSpineIndex; spineIndex++) {
    await ensureSummaryForChapter(book, bookId, spineIndex);
  }
}

export async function ensureSummaryForChapter(book, bookId, spineIndex) {
  const existing = await getSummary(bookId, spineIndex);
  if (existing) return existing.summaryText;

  const text = await getChapterText(book, spineIndex);
  const contentHash = hashText(text);

  if (text.length < MIN_CHAPTER_TEXT_LENGTH) {
    await saveSummary(bookId, spineIndex, contentHash, '');
    return '';
  }

  const summaryText = await requestSummaryFromApi(text);
  await saveSummary(bookId, spineIndex, contentHash, summaryText);
  return summaryText;
}

async function requestSummaryFromApi(chapterText) {
  const system =
    "You summarize one chapter of a book at a time for a reader's personal notes. " +
    'Write a concise summary (3-6 sentences) covering plot events, character developments, ' +
    'and key details from THIS chapter only. ' +
    'Only use the chapter text provided below - do not add outside knowledge about the book, ' +
    'its author, or how the story unfolds elsewhere, since the reader has not read past this point.';

  return sendMessage({
    system,
    messages: [{ role: 'user', content: `Summarize this chapter:\n\n${chapterText}` }],
    maxTokens: SUMMARY_MAX_TOKENS,
  });
}
