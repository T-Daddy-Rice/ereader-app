// Lazily generates and caches per-chapter summaries, used by
// context-builder.js to give the AI companion a compact view of
// everything before the reader's current chapter (instead of sending the
// full text of every prior chapter on every chat message).
//
// "Chapter" here normally means one epub.js spine item - the unit epub.js
// already splits the book into. That doesn't always line up perfectly
// with the author's own chapter breaks (a chapter can span multiple
// spine items in some EPUBs), but it's a consistent, simple boundary to
// key everything off of.
//
// Some EPUBs (often ones from Project Gutenberg) go the other way: the
// WHOLE book ends up as one giant spine item, with real chapter breaks
// marked only by heading tags (<h2>, <h3>, etc.) inside that one file.
// getChapterSegments() below detects that case - when a spine item is
// unusually large - and splits it into "segments" (one per heading) so
// the rest of the app can treat each real chapter as its own unit again:
// its own cached summary, its own place in the reader's progress. For a
// normal, well-formed spine item, getChapterSegments() just returns that
// one item as a single segment, so nothing about this changes cost or
// behavior for the common case.

import {
  getSummary,
  saveSummary,
  hashText,
} from './db.js';
import { sendMessage } from './claude-api.js';
import { SUMMARY_MAX_TOKENS, MAX_CHAPTER_TOKENS, MIN_SPLIT_HEADING_COUNT, estimateTokens } from './constants.js';

// Spine items shorter than this are things like cover/title pages with no
// real content worth summarizing - we cache an empty summary for them so
// we don't keep re-checking (and re-loading their section) every time.
// Applies per-segment too, e.g. any stray text before a book's first
// heading that doesn't amount to real chapter content.
const MIN_CHAPTER_TEXT_LENGTH = 40;

// Segment lists are expensive to (re)compute for a huge spine item -
// loading it, scanning for headings, extracting each range's text - and
// reader.js asks for them on every single page turn (including turns
// within the same giant file), so they're cached here for as long as the
// current book is open. clearSegmentCache() is called when a book closes.
const segmentCache = new Map(); // spineIndex -> segments array

export function clearSegmentCache() {
  segmentCache.clear();
}

async function loadSection(book, spineIndex) {
  const section = book.spine.get(spineIndex);
  if (!section) return null;
  const contents = await section.load(book.load.bind(book));
  return { section, contents };
}

// Looks for whichever heading level (h1-h6) is being used as this
// section's real chapter markers - the level with the most occurrences,
// ties broken toward the deeper/more specific level (e.g. h3 over h2).
// Returns null if no level appears often enough to be a chapter marker
// (MIN_SPLIT_HEADING_COUNT) rather than a one-off section heading.
function detectHeadingSplitLevel(contents) {
  let bestLevel = null;
  let bestCount = 0;
  for (let level = 6; level >= 1; level--) {
    const count = contents.querySelectorAll(`h${level}`).length;
    if (count > bestCount) {
      bestCount = count;
      bestLevel = level;
    }
  }
  return bestCount >= MIN_SPLIT_HEADING_COUNT ? bestLevel : null;
}

// Splits a loaded section's content into segments at each heading of the
// given level. Segment 0 is everything before the first heading (usually
// empty or near-empty, but kept for completeness); segment N covers from
// heading N-1 up to (not including) heading N, or to the end of the
// section for the last one. Each segment beyond 0 carries the CFI of the
// heading it starts at, used later to figure out which segment the
// reader's current position falls in (see segmentIndexForCfi()).
function extractHeadingSegments(section, contents, level) {
  const headings = Array.from(contents.querySelectorAll(`h${level}`));
  const doc = contents.ownerDocument;
  const boundaries = [null, ...headings]; // null marks the start of the file

  return boundaries.map((heading, i) => {
    const range = doc.createRange();
    if (heading === null) {
      range.setStart(contents, 0);
    } else {
      range.setStartBefore(heading);
    }
    if (i + 1 < boundaries.length) {
      range.setEndBefore(boundaries[i + 1]);
    } else {
      range.setEnd(contents, contents.childNodes.length);
    }

    const text = (range.toString() || '').replace(/\s+/g, ' ').trim();
    const headingCfi = heading === null ? null : section.cfiFromElement(heading);
    return { segmentIndex: i, headingCfi, text };
  });
}

// Returns this spine item's content as an array of one or more segments:
// [{ segmentIndex, headingCfi, text }, ...]. Normal-sized chapters always
// come back as a single segment (segmentIndex 0, headingCfi null) - same
// text getChapterText() used to return, just wrapped in an array, and at
// no extra ongoing cost thanks to the cache above (previously this text
// was re-extracted on every call; now only on the first).
export async function getChapterSegments(book, spineIndex) {
  if (segmentCache.has(spineIndex)) {
    return segmentCache.get(spineIndex);
  }

  const loaded = await loadSection(book, spineIndex);
  if (!loaded) return [{ segmentIndex: 0, headingCfi: null, text: '' }];
  const { section, contents } = loaded;

  const fullText = (contents.textContent || '').replace(/\s+/g, ' ').trim();

  // Always check for chapter-marking headings, not just when the spine
  // item is already oversized. Some EPUBs (e.g. Project Gutenberg's,
  // which chunk the book by file size rather than by chapter) bundle
  // several real chapters into one spine item that still comes in under
  // MAX_CHAPTER_TOKENS - a book split into two ~150k-character chunks of
  // six-ish chapters each still needs per-chapter segments for the
  // no-spoiler boundary (see context-builder.js), even though neither
  // chunk is "oversized" on its own. detectHeadingSplitLevel()'s
  // MIN_SPLIT_HEADING_COUNT check already guards against splitting a
  // normal single chapter that just happens to contain a repeated
  // subheading.
  const level = detectHeadingSplitLevel(contents);
  const segments = level
    ? extractHeadingSegments(section, contents, level)
    : [{ segmentIndex: 0, headingCfi: null, text: fullText }];

  section.unload();
  segmentCache.set(spineIndex, segments);
  return segments;
}

// Given the segments for a spine item and the reader's current CFI (from
// epub.js's 'relocated' event), returns which segment they're currently
// in - the last one whose heading they've reached or passed. Segment 0
// is the default/fallback (its "heading" is implicitly the start of the
// file, always true).
export function segmentIndexForCfi(book, segments, cfi) {
  for (let i = segments.length - 1; i >= 1; i--) {
    if (book.spine.epubcfi.compare(cfi, segments[i].headingCfi) >= 0) {
      return segments[i].segmentIndex;
    }
  }
  return 0;
}

// Ensures every chapter from 0 to furthestSpineIndex (inclusive) has a
// cached summary, generating any that are missing. Called in the
// background as the reader turns pages, and again defensively before
// assembling chat context in case the background pass hasn't caught up.
//
// furthestSegmentIndex matters only for the spine item that IS the
// reading frontier right now (spineIndex === furthestSpineIndex AND
// spineIndex === currentSpineIndex) - only its already-read segments
// (0..furthestSegmentIndex-1) get summarized, never the one being read
// or any beyond it. Every OTHER spine item in range - including the
// current one, if the reader has paged backward to reread an earlier
// chapter while a later one is still the real frontier - has necessarily
// been fully passed already (furthestSpineIndex only grows), so all of
// its segments are safe to summarize in full regardless of
// furthestSegmentIndex (which, in that case, describes the frontier
// chapter, not this one).
export async function ensureSummariesUpTo(book, bookId, currentSpineIndex, furthestSpineIndex, furthestSegmentIndex) {
  for (let spineIndex = 0; spineIndex <= furthestSpineIndex; spineIndex++) {
    const isActiveFrontier = spineIndex === furthestSpineIndex && spineIndex === currentSpineIndex;
    if (isActiveFrontier) {
      const segments = await getChapterSegments(book, spineIndex);
      for (const segment of segments) {
        if (segment.segmentIndex >= furthestSegmentIndex) break;
        await ensureSummaryForSegment(book, bookId, spineIndex, segment);
      }
    } else {
      await ensureSummaryForChapter(book, bookId, spineIndex);
    }
  }
}

// Summarizes every segment of a spine item (just one, for a normal
// chapter). Safe to call on a spine item the reader has fully passed.
export async function ensureSummaryForChapter(book, bookId, spineIndex) {
  const segments = await getChapterSegments(book, spineIndex);
  const summaries = [];
  for (const segment of segments) {
    summaries.push(await ensureSummaryForSegment(book, bookId, spineIndex, segment));
  }
  return summaries.join('\n\n');
}

export async function ensureSummaryForSegment(book, bookId, spineIndex, segment) {
  const existing = await getSummary(bookId, spineIndex, segment.segmentIndex);
  if (existing) return existing.summaryText;

  const contentHash = hashText(segment.text);

  if (segment.text.length < MIN_CHAPTER_TEXT_LENGTH) {
    await saveSummary(bookId, spineIndex, contentHash, '', segment.segmentIndex);
    return '';
  }

  const summaryText = await requestSummaryFromApi(segment.text);
  await saveSummary(bookId, spineIndex, contentHash, summaryText, segment.segmentIndex);
  return summaryText;
}

async function requestSummaryFromApi(chapterText) {
  // A single segment can still end up oversized (e.g. a book with only
  // two or three headings across a huge file) - guard here too, the same
  // way context-builder.js guards the chat-time chapter text, so a
  // summarization call can never blow the model's context window either.
  let text = chapterText;
  if (estimateTokens(text) > MAX_CHAPTER_TOKENS) {
    text =
      text.slice(0, MAX_CHAPTER_TOKENS * 4) +
      '\n\n[This chapter is very long and was cut off here - only summarize what appears above.]';
  }

  const system =
    "You summarize one chapter of a book at a time for a reader's personal notes. " +
    'Write a concise summary (3-6 sentences) covering plot events, character developments, ' +
    'and key details from THIS chapter only. ' +
    'Only use the chapter text provided below - do not add outside knowledge about the book, ' +
    'its author, or how the story unfolds elsewhere, since the reader has not read past this point.';

  const { text: summary } = await sendMessage({
    system,
    messages: [{ role: 'user', content: `Summarize this chapter:\n\n${text}` }],
    maxTokens: SUMMARY_MAX_TOKENS,
  });
  return summary;
}
