# Prompt for Claude Code

Build me a personal e-reader web app as a Progressive Web App (PWA). I am the only user. It will be hosted as static files on GitHub Pages (no backend server), and I will use it almost exclusively in Safari on my iPad, added to the home screen. I'm an experienced Python developer but not a JavaScript expert, so keep the code clean and commented.

## Core concept

An EPUB reader with an AI reading companion. While reading, I can open a chat panel and ask freeform questions about the book — "What just happened in this chapter?", "Who is this character again?", "Recap everything so far", "What is the author doing stylistically here?" The app sends my question to the Claude API along with the relevant book text, and the answer must never contain spoilers from beyond my current reading position.

## Features

### Reader
- Upload/import EPUB files from the iPad (file picker). Store books in IndexedDB (they're too large for localStorage).
- Render EPUBs with epub.js. Support multiple books in a simple library view.
- Standard reading controls: font size, serif/sans toggle, light/dark/sepia themes, page turns via tap or swipe.
- Remember reading position per book automatically. Support bookmarks.
- Work fully offline for reading (service worker caches the app shell; books are already local in IndexedDB).

### AI companion
- A chat drawer that slides over the reading view, with a freeform text input. No preset question buttons.
- Calls the Anthropic Messages API directly from the browser using model `claude-sonnet-4-6`. Note: browser-direct calls require the `anthropic-dangerous-direct-browser-access: true` header — verify current requirements against the docs at https://docs.claude.com/en/api/overview.
- Settings screen where I paste my Anthropic API key once; store it in localStorage. Never commit a key to the repo.
- **Context assembly (the important part):** when I ask a question, send (a) the full text of the chapter I'm currently in, (b) short cached summaries of all prior chapters, and (c) my question, plus recent chat history for this book so follow-up questions work. Never include any text beyond my current reading position — enforce the no-spoiler rule in both the context and the system prompt you write for the API call.
- Generate prior-chapter summaries lazily: when I finish a chapter (or when a summary is first needed), summarize it via the API and cache the summary in IndexedDB so it's never generated twice.
- Persist chat history per book.
- Handle API errors gracefully (bad key, no network, rate limits) with clear messages. Reading must keep working with no network; only the chat requires a connection.

## PWA requirements
- Web app manifest (name, icons, standalone display) so "Add to Home Screen" on iPad gives a full-screen app with its own icon.
- Service worker for offline app-shell caching.
- Layout optimized for iPad (portrait and landscape), but usable on desktop Safari too.

## Tech constraints
- Static files only: HTML/CSS/vanilla JS or a lightweight build that outputs static files. Must deploy to GitHub Pages from the repo.
- Use epub.js for rendering; minimize other dependencies.
- Single user. No accounts, no login, no analytics.

## Deliverables
1. The complete working app in this folder, with a sensible file structure.
2. A local dev server command so I can test from my iPad over my home wifi before deploying.
3. A README with: how to deploy to GitHub Pages, how to add the app to my iPad home screen, and how to enter my API key.
4. Initialize a git repo and set it up for GitHub Pages deployment.

Start by proposing the file structure and confirming the plan, then build it.
