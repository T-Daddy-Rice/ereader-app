# Reader

A personal EPUB reader PWA with an AI reading companion. Static files only,
no backend — everything runs in the browser. Books live in IndexedDB on
your device; chat questions go straight from your browser to the Anthropic
API.

## How it works

- **Reader**: import `.epub` files, read them with page turns (tap the
  left/right edge, swipe, or use arrow keys), adjust font size/typeface/
  theme, bookmark pages. Your position is saved automatically per book.
  Reading works fully offline once the app and book are loaded.
- **AI companion**: tap the chat icon while reading to ask freeform
  questions ("what just happened?", "who is this character again?").
  Answers are built only from the current chapter's full text plus
  summaries of chapters you've already read — never anything further
  ahead in the book. Chat requires an internet connection; reading does
  not.
- **Chapter** in this app means one epub.js "spine item" (roughly, one
  file inside the EPUB) — usually matches the author's chapters, but very
  occasionally a chapter may span more than one spine item.

## Local development

No build step and no npm — just static files. Serve them with Python
(you already have it):

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Then, on your Mac, find your LAN IP (System Settings → Wi-Fi → Details, or
`ipconfig getifaddr en0`), and open `http://<that-ip>:8000` in Safari on
your iPad (same wifi network).

**Caveat:** service workers (used for offline app-shell caching) only run
in a "secure context" — HTTPS or `localhost`. Testing over
`http://<lan-ip>:8000` is neither, so offline caching won't activate
during local testing; reading and chat will still work fine over wifi for
functional testing, you just won't be able to verify true offline/airplane-
mode behavior until it's deployed to GitHub Pages (which is HTTPS). "Add to
Home Screen" also works for a quick look during dev, but treat GitHub
Pages as the real test for the full installed-app experience.

## Deploying to GitHub Pages

This folder is already a git repo with an initial commit, but has no
GitHub remote yet. To deploy:

1. Create a new (empty) repository on GitHub — don't initialize it with a
   README/license, since this folder already has commits.
2. Point this repo at it and push:

   ```sh
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages** → under "Build and deployment", set
   **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`.
   Save.
4. After a minute or two, your app will be live at
   `https://<your-username>.github.io/<repo-name>/`.

Any time you change a file under `css/`, `js/`, `vendor/`, `icons/`,
`index.html`, or `manifest.webmanifest`, bump `CACHE_NAME` at the top of
`service-worker.js` (e.g. `v1` → `v2`) before pushing, so returning
visitors pick up the new version instead of a stale cached one.

## Adding to your iPad home screen

1. Open the deployed GitHub Pages URL in Safari on your iPad.
2. Tap the Share icon → **Add to Home Screen**.
3. Launch it from the home screen icon — it opens full-screen, no Safari
   chrome, and works offline for reading.

## Entering your Anthropic API key

1. In the app, tap the gear icon on the library screen to open
   **Settings**.
2. Paste in an API key from
   [console.anthropic.com](https://console.anthropic.com/settings/keys)
   and tap **Save key**.
3. The key is stored only in this browser's `localStorage` on this
   device — it's never written to any file in this repo and never sent
   anywhere except directly to Anthropic's API when you use chat.

If you ever want to remove it, clear the field in Settings and save again,
or clear this site's data in Safari settings.

## File structure

```
index.html              App shell: library + reader + chat + settings views
manifest.webmanifest     PWA manifest
service-worker.js        Offline app-shell caching
css/                      base.css, library.css, reader.css, chat.css
js/
  app.js                  Entry point / view routing
  db.js                   IndexedDB wrapper (books, progress, bookmarks, summaries, chat)
  library.js              Import/list/delete books
  reader.js                epub.js integration, controls, position tracking
  chat.js                  Chat drawer UI
  context-builder.js       Assembles the no-spoiler context sent to Claude
  summarizer.js             Lazy per-chapter summary generation/caching
  claude-api.js             Anthropic Messages API fetch wrapper
  settings.js                API key entry
  constants.js                Model name, API version, and other one-line-change knobs
vendor/                  Vendored epub.js + JSZip (not npm - plain <script> includes)
icons/                   App icons for the manifest/home-screen icon
```
