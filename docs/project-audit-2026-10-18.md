# Endpaper — full project audit (18 October 2026)

> **Updated after a second pass the same day.** The uncommitted fixes from the "Docker deployment and XSS vulnerabilities" session were re-verified, and the UI was re-audited with the taste-skill `redesign-existing-projects` checklist. See [§0 Re-audit](#0-re-audit-second-pass) for what changed. Sections 1–7 keep the original findings, with a status on each one.

## 0. Re-audit (second pass)

### What was re-run

| Check | First pass | Second pass |
|---|---|---|
| `npm test` | 4/4 pass | **6/6 pass** (new validation and import tests) |
| Playwright, Chromium | 84/84 pass | **84/84 pass** (1.7 min) |
| `npm audit --omit=dev` | 1 critical, 2 high | **0 vulnerabilities** |
| API repro probe (same script) | 8 bugs reproduced | 4 fixed, 5 still reproduce (below) |

### Status of the original findings

| ID | Finding | Status | Evidence |
|---|---|---|---|
| C1 | Docker paths | **Fixed** (not yet run in a container) | New `server/src/lib/paths.js`; `ENDPAPER_DATA_DIR`/`ENDPAPER_PUBLIC_DIR` set in the Dockerfile and compose; the server logs an error when `index.html` is missing |
| C2 | Bookmark XSS | **Fixed** | `escapeHtml` now escapes `"` and `'`; the bookmark row is built with DOM APIs; search highlighting no longer runs a regex over escaped HTML (this also fixes M19) |
| C3 | Writes fail over plain HTTP | **Fixed** | `uuidV4()` falls back to `crypto.getRandomValues`; queued non-UUID keys are re-keyed on flush |
| C4 | Backup round-trip | **Fixed** [repro] | Export then import now returns 200. Fractional rating PATCH returns 400. Upload metadata is clipped to shared `BOOK_TEXT_LIMITS`. Import truncates/rounds instead of failing and reports `adjustments` |
| C5 | Vulnerable dependencies | **Fixed** [repro] | `npm audit`: 0 vulnerabilities (sharp 0.35.5, lockfile refreshed) |
| H7 | `cover_color` injection | **Mitigated** | Import now resets non-hex colours. The two raw `style="background:${entry.coverColor}"` renderers remain (`public/app.js:5101, 5465`), so rows imported before this fix are not sanitised |
| H1–H6 | Session inflation, PM2 lockout and cookies, pino logging, 140-character highlights, dark-only themes, automatic dictionary lookups | **Still open** | Confirmed in the current code: no `visibilitychange`/`pagehide` handling; `slice(0, 140)` at `app.js:2599`; dictionary fetch at `app.js:4984`; six `logger.error('…', err)` calls in `server/src/index.js` |
| M1, M2, M3, M4, M5 | Array query params, settings type coercion, mark-unread, numeric ISBN, login timing | **Still open** [repro] | Probe: `?search=a&search=b` returns 500; `"42"` comes back as a number; `status: unread` comes back as `reading`; ISBN `0123456789` becomes `null`; unknown user 1 ms vs known 50 ms |
| M19 | Search-highlight entity corruption | **Fixed** | Same change as C2 |
| Other M- and low items | | **Still open** | No changes in those areas |

**Not yet done:** none of these fixes are committed. The Docker image hasn't been built and run. The changes have no new Playwright test for the bookmark XSS.

### Taste-skill design audit (`redesign-existing-projects`)

This was run as an audit only, with no redesign, against desktop (1440×900) and phone (375×812) in both shells, using live DOM measurements.

**Typography**
- **Only one weight in the shell.** Every visible shell text node measured is DM Sans 400 or Instrument Serif 400, apart from two DM Sans 500 nodes. Headings rely on size alone, and the 500/600 weights in the CSS barely appear. *Fix:* give section headings, card titles and active nav a clear 500/600 step.
- **Font sprawl.** Eight families ship: Georgia (`--font-display` in app.css), system-ui (`--font-ui`), Instrument Serif and DM Sans/DM Mono (ui.css overrides), plus Atkinson, Work Sans, Palatino and Courier for the reader. The shell's real identity, Instrument Serif and DM Sans, lives only in override rules. *Fix:* point the `--font-display`/`--font-ui` tokens at the real faces and delete the dead fallback layer.
- **Small-caps eyebrows everywhere.** "ENDPAPER", "THE SHARED SHELF", "FIND YOUR NEXT BOOK", "ENDPAPER TESTS" on covers; there are 9 `text-transform: uppercase` rules. Use them sparingly.
- **Tabular numbers missing** on stats, percentages and page counts (one `tabular-nums` rule in the whole UI), so progress numbers jitter as they change.
- `text-wrap: balance/pretty` appears only twice; long book titles ("Frankenstein; or, the modern prometheus") break unevenly in cards.

**Colour and surfaces**
- **Near-pure black page themes.** "Original" `#050505` and "Bold" `#060606` with `#FFFFFF` text: maximum contrast with halation for long reading. Combined with H5 (no light theme), the reader has no comfortable daytime option.
- **Hard-coded colours bypass the tokens.** About 40 literal hex colours in the mobile block of `app.css`, e.g. `.mobile-actions-sheet { background:#2b2924; color:#f4eee2 }` and `select { color:#fff }`. In the light shell they look right only because `ui.css` overrides them later, so any cascade change brings back dark panels on a light page.
- **Generic black shadows.** 69 `box-shadow` declarations, mostly `var(--shadow)` (a black alpha) or `#0003`, never tinted to the green and paper palette.

**Layout**
- **Covers misaligned in rails and grids.** Real covers and generated placeholder covers have different aspect ratios and offsets, so titles under them start at different heights (Home "Recently added", Library grid). *Fix:* force one aspect ratio (2:3) with `object-fit: cover` and pin titles to a common baseline.
- **Library grid is sparse at desktop widths.** At 1440 px, three 150 px cards sit at the left with most of the row empty, and the cover is narrower than its own meta column (the progress rule extends past the cover).
- **The "…" menu button covers placeholder titles** ("Three Chapter Test B…", "Image Only Test Boo…").
- **Count shown twice** on Library ("3 books in your shared library" and "3 books").
- **Repeated content on Home:** the same books appear in "Recently added" and "Unread" side by side.

**Interactivity and states**
- **Almost no press feedback.** There are 66 `:hover` rules but only 7 `:active` rules, all in `ui.css`. Most buttons, cards and rows give no response on press, which matters on touch.
- **Reader chrome on desktop** auto-hides after 3 s with no hover reveal (M16, still open).
- **Spinner loading states.** Opening a book and uploads use a circular spinner; shelf and notebook loading are plain text ("Loading highlights…"). Cover-shaped skeletons would fit the layout.
- **Browser `prompt()` dialogs** remain for rename collection, bulk collection and bulk series (M12): no inline validation, and a typo creates a collection.
- **No skip-to-content link.**

**Components and code quality**
- 40 inline `style="…"` attributes in `index.html`, plus many `style.cssText` strings in `app.js`, outside the token system.
- `z-index` ladder is ad hoc: 2, 4, 15, 30, 40, 76, 90, 100–140, 250, 400, 500, **10000** (`#dict-tooltip`).
- Two parallel style sheets (`app.css` and `ui.css`) with 40 `!important`s fighting each other.
- No `og:` / social meta tags (low priority for a private, self-hosted app).

**What already passes the checklist:** a distinctive serif and sans pairing rather than Inter; one restrained accent colour (green, with gold for ratings); off-black rather than pure-black shell backgrounds (`#12151A`); `100dvh` used throughout; visible active nav state; focus-visible rings; Lucide icons at a consistent stroke; branded favicon and maskable manifest entries; real empty, error and retry states; no AI copy clichés or exclamation marks.

**Priority order (per the skill's fix sequence):**
1. Typography: wire the real fonts into tokens, add a 500/600 hierarchy, tabular numbers, balanced titles.
2. Palette: add light and sepia reading themes, soften the near-black themes, replace the hard-coded mobile colours with tokens, tint shadows.
3. Press and hover states on cards, rows and buttons; desktop hover reveal for reader chrome.
4. Layout: one cover aspect ratio, a denser desktop grid, move the card menu off the title, deduplicate counts and rails.
5. Replace `prompt()` with in-app dialogs; skeleton loaders for shelf and notebook.

---

The original first-pass scope: every tracked source file (server, frontend, service worker, tests, Docker/Caddy/PM2 docs, scripts), plus a live run of the app in an isolated instance (temporary data directory, fixture admin, three fixture EPUBs) at 1366×860 and 375×812, in dark and light shells.

## How this was verified

| Check | Result |
|---|---|
| `npm test` (node:test) | 4/4 pass |
| `npx playwright test --browser chromium` | 84/84 pass (1.8 min) |
| `npm audit --omit=dev` | **3 vulnerabilities: 1 critical, 2 high** (all have fixes) |
| `npm outdated` | express 4 → 5, better-sqlite3 11 → 13, express-rate-limit 7 → 8, sharp 0.35.4 → 0.35.5 |
| Isolated API probe script | 8 server bugs reproduced (marked **[repro]** below) |
| Browser audit | XSS attribute injection reproduced, reader/desktop UX issues observed |
| Impeccable detector | Contrast failures on primary buttons, decorative pulsing dot |

Findings are tagged **[repro]** when reproduced against a running instance, **[code]** when confirmed by reading the code path, and **[ux]** when observed in the browser.

The test suite is good at what it covers. Every bug below slipped past it, so each fix should come with a regression test.

---

## 1. Critical: fix first

### C1. The Docker deployment stores data in the wrong place and cannot serve the frontend [code] — ✅ fixed (pass 2)
- `server/Dockerfile` copies `src/` to `/app/src`. `index.js` resolves `PUBLIC_DIR` as `path.resolve(__dirname, '../../public')`, which is `/public`, and `DATA_DIR` as `../../data`, which is `/data` (`server/src/index.js:16-18, 842`, `server/src/db.js:7-9`, `server/src/routes/books.js:17-19`).
- `docker-compose.yml:5-6` mounts `./data:/app/data` and `./public:/app/public`.
- Result: the frontend is missing, so `sendFile('/public/index.html')` errors on every page. All books, covers and the SQLite DB are written to the container's ephemeral `/data` and **lost on every `docker compose build`/recreate**. DEPLOY.md's claim that data "remains in the bind-mounted `data/` directory" is false.
- Fix: set `ENDPAPER_DATA_DIR=/app/data` in compose. Add an `ENDPAPER_PUBLIC_DIR` (or copy `public/` into the image and resolve it relative to the app root). Add a container smoke test to CI.

### C2. Stored XSS via EPUB chapter labels in the bookmarks list [repro] — ✅ fixed (pass 2)
- `escapeHtml()` (`public/app.js:931`) uses `textContent → innerHTML`, which escapes `& < >` but **not quotes**. It is then used inside an attribute: `aria-label="Remove bookmark in ${escapeHtml(bm.chapter)}"` (`public/app.js:2478`).
- `bm.chapter` comes from the EPUB's navigation label. Any reader can upload an EPUB, so a crafted TOC label such as `x" onmouseover="…` injects an event handler. Reproduced: the rendered button gained `data-injected="yes"` and an `onfocus` attribute.
- The page CSP allows `script-src 'unsafe-inline'` (`server/src/index.js:79`), so inline handlers run with the victim's session. An admin victim gives the attacker full library/user control.
- Fix: build that row with DOM APIs (as `annotationRow` already does), or make `escapeHtml` escape `"` and `'`. Then remove the inline `onclick=` handlers from `index.html` and the generated markup so `'unsafe-inline'` can be dropped from `script-src`.

### C3. Every write fails on plain-HTTP deployments (the documented Tailscale option) [repro] — ✅ fixed (pass 2)
- `crypto.randomUUID` exists only in secure contexts. On `http://100.x.y.z:3001` (README "Option 3"), `resilientApiPost` falls back to `` `${Date.now()}-${Math.random()}` `` (`public/app.js:3288`). The server rejects non-UUID `Idempotency-Key` with **400** (`server/src/index.js:104`). Reproduced: status 400.
- Effect: progress saves, bookmarks, highlights and notes all fail. Because a 400 is an HTTP error, they are **not queued**; they are dropped (`app.js:3307`). Offline snapshots are silently disabled too (`crypto.subtle` is also secure-context-only).
- Fix: generate a v4 UUID from `crypto.getRandomValues` (available on HTTP). Document that offline features need HTTPS, or recommend `tailscale serve` with HTTPS.

### C4. The app's own backup cannot be re-imported [repro] — ✅ fixed (pass 2)
- Upload stores EPUB metadata unbounded (`server/src/routes/books.js:242-244`). PATCH accepts fractional ratings (`books.js:457`, `number()` has no integer check). Import enforces stricter rules: rating must be an integer; description ≤ 5000; tags/ISBN ≤ 500 (`server/src/index.js:224-229, 248`).
- Reproduced: after `PATCH {rating: 3.5}`, `GET /api/export` then `POST /api/import` returns `400 Invalid book rating in backup`. A book whose EPUB description is over 5000 characters (common for publisher blurbs) or with many `dc:subject` tags breaks import the same way.
- One bad row aborts the whole restore, which is the worst moment for a backup to fail.
- Fix: share one validator between write paths and import. Truncate/normalise metadata at upload. Make `rating` integer-only. Have import truncate or skip a bad row and report it instead of failing everything.

### C5. Dependency vulnerabilities [repro] — ✅ fixed (pass 2)
- `proxy-addr` (critical: IP spoofing via IPv4-mapped IPv6 trust subnet; relevant because `trust proxy` is configurable). `sharp < 0.35.5` (high: librsvg; EPUB covers can be SVG and go through sharp). `brace-expansion` (high: ReDoS).
- Fix: `npm audit fix` in `server/`, then rerun both test suites. **Status (pass 2): resolved; `npm audit` now reports 0 vulnerabilities.**

---

## 2. High severity

### H1. Reading time is badly inflated by abandoned sessions [code]
- No `visibilitychange`/`pagehide` handling exists anywhere in `public/`. Only `beforeunload` sends the end beacon (`app.js:3509`), and mobile Safari and installed PWAs often don't fire it.
- An abandoned session is closed at the *next* session start with `ended_at = now` (`server/src/routes/sessions.js:37-39`). Leave a book on your phone overnight and the stats record ~12 hours of "reading". Streaks, weekly totals, "most read" and the personal WPM estimate all absorb it.
- The last ≤1.2 s of progress is also lost on close, because `scheduleSaveMeta` is debounced and never flushed.
- Fix: end or pause sessions on `visibilitychange: hidden`/`pagehide` (with `sendBeacon`), and flush the pending progress save. Add a heartbeat (`last_active_at`) and cap the closed duration at last activity plus a small idle window.

### H2. Login lockout DoS and spoofable rate limits behind the README's PM2 + Caddy setup [code]
- README Option 1 and DEPLOY.md's PM2 section put Caddy in front but never set `TRUST_PROXY`. Every request then appears to come from `127.0.0.1`. The per-account limiter (`ip + username`, 5 per 15 min, `server/src/routes/auth.js:43-51`) becomes **global per username**: anyone on the internet can lock the admin out by sending 5 bad passwords every 15 minutes.
- The same docs never set `NODE_ENV=production`, so the session cookie is sent **without `Secure`** and HSTS is off (`auth.js:83`, `index.js:81`).
- Fix: document `TRUST_PROXY=loopback` and `NODE_ENV=production` for PM2 (or an `ecosystem.config.js`). Better, default the cookie's `secure` flag to `req.secure`.

### H3. Server errors are logged without the error [repro]
- `logger.error('Export error:', err)` is not a pino signature. Pino logs only the message and **drops the error and stack** (reproduced). This affects `server/src/index.js:606, 643, 836, 856`. The routes also mix in `console.error`, bypassing pino entirely.
- Fix: `logger.error({ err }, 'Export error')` everywhere; pass the pino logger into the routes. Also fix the literal `\n` in the shutdown message (`index.js:873`).

### H4. Highlights save only the first 140 characters [code]
- `context.excerpt = text.length > 140 ? text.slice(0, 140) + '…' : text` (`app.js:2574`). That truncated value is what's POSTed, even though the server allows 1000.
- Every longer highlight is permanently cut off in the notebook, search and the Markdown export.
- Fix: send the full selection (up to the server limit) and truncate only for display.

### H5. No light page theme: all six reading themes are dark [ux]
- `THEMES` (`app.js:482-489`): "Paper" is `#29292B`, "Original" is `#050505`. Legacy `light` and `sepia` settings are silently remapped to dark themes (`app.js:491`).
- Readers who prefer light or sepia pages, or read in daylight, have no option. Highlights also use `mix-blend-mode: screen` on the assumption that every page is dark (`app.js:2642`).
- Fix: add Light, Sepia and Paper-white themes. Make highlight blending theme-aware (`multiply` on light pages). Rename "Paper" if it stays dark.

### H6. Third-party lookups of what you are reading, without consent [code]
- Every single-word selection automatically calls `https://api.dictionaryapi.dev` (`app.js:1716-1728, 4952`). For a self-hosted, privacy-oriented app this leaks reading content to a third party. It also pops a tooltip on top of the highlight popup on every one-word selection, including when you just want to highlight that word.
- Fix: look up only on the explicit "Define" action. Add a setting to disable lookups, or point them at a self-hostable dictionary.

### H7. A second XSS vector through `cover_color` [code] — ⚠️ mitigated (pass 2)
- `style="background:${entry.coverColor}"` is interpolated into `innerHTML` unsanitised (`app.js:5069, 5433`; other renderers validate it against a hex regex). Backup import accepts any ≤32-character string for `cover_color` (`index.js:234`), and `"><img src=x onerror=…>` fits.
- Requires a crafted backup imported by an admin, so it is low likelihood, but it becomes stored XSS for every user.
- Fix: validate hex on import and in these two renderers.

---

## 3. Medium severity

| # | Issue | Where | Evidence |
|---|---|---|---|
| M1 | Repeated query params crash `/api/books` with 500 (`?search=a&search=b`, `?filter=…` twice) | `books.js:90-103` | [repro] |
| M2 | Settings type corruption: string `"42"` comes back as number 42, `"true"` as boolean | `settings.js` GET `JSON.parse` fallback | [repro] |
| M3 | "Mark as unread" is impossible once progress > 0: the PATCH auto-flips it to `reading` | `books.js:499-508` | [repro] |
| M4 | Numeric EPUB metadata mangled: `fast-xml-parser` parses tag values as numbers, so ISBN `0123456789` → `null` (leading zero lost); numeric titles take a fallback path | `epubMeta.js:9-14` (set `parseTagValue:false`) | [repro] |
| M5 | Username enumeration by timing: unknown user ~1 ms vs known user ~50 ms (bcrypt runs only for real users) | `auth.js:66-76` | [repro] |
| M6 | Status/"finished" semantics disagree: server filters and the "books finished" stat use `progress ≥ 98`; the client and manual status use `status` | `books.js:99-102`, `sessions.js` stats, `ui.js:10` | [code] |
| M7 | EPUB paths not normalised: `opfDir + href` without resolving `../`; one malformed `%` in any href throws `URIError` and discards **all** metadata (title/author/cover) | `epubMeta.js:150, 214-216` | [code] |
| M8 | EPUB descriptions are usually HTML; shown escaped, so users see raw `<p>…</p>` tags in book details | upload path + `app.js:5433`, `mobile.js:484` | [code] |
| M9 | `client_operations` (idempotency receipts) grows forever; index exists but nothing prunes it | `db.js:168-186` | [code] |
| M10 | Pre-migration backup uses `copyFileSync` on a WAL-mode DB, which can produce an inconsistent copy; use `db.backup()` / `VACUUM INTO` | `db.js:38, 355` | [code] |
| M11 | Bulk actions have no error handling: `bulkDownloadOffline`, `bulkAddToCollection`, `bulkEditSeries` throw unhandled rejections with partial progress and no message | `app.js:5348-5392` | [code] |
| M12 | `bulkAddToCollection` uses `prompt()`; a typo **creates a new collection** | `app.js:5355-5358` | [code] |
| M13 | Session tokens stored in plaintext; a DB/backup snapshot leak equals live sessions (store SHA-256 of the token) | `auth.js:20, 79` | [code] |
| M14 | Users cannot change their own passphrase, see active devices, or "sign out everywhere"; only an admin reset exists | missing feature | [code] |
| M15 | Passphrase handling inconsistent: create/reset `.trim()` the passphrase, login doesn't. A passphrase with edge spaces set by an admin can never be typed correctly | `app.js:4197, 4219` vs `auth.js` | [code] |
| M16 | Desktop reader controls auto-hide after 3 s even with a mouse; hovering doesn't reveal them and the reveal button is `display:none` on desktop. When shown, the top bar covers the first lines of text | `app.js:1498-1519` | [ux] |
| M17 | `reindexWordCounts.js` rewrites cover files as a side effect (calls `extractMeta`) without updating `cover_path` | `reindexWordCounts.js` | [code] |
| M18 | Stats parse `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, no `Z`) with `new Date()`, which is interpreted as **local** time on the server | `sessions.js` stats query | [code] |
| M19 | Search-result highlighting regex runs over escaped HTML; a query like `amp`/`lt` corrupts entities in results | `app.js:2869-2877` | [code] ✅ fixed (pass 2) |
| M20 | `allowScriptedContent: true` makes the EPUB iframe `sandbox="allow-same-origin allow-scripts"` (verified in the e2e logs), which nullifies the sandbox. Defence relies on DOM scrubbing plus a meta CSP. Reasonable, but worth a dedicated origin or dropping `allow-scripts` where WebKit allows | `app.js:1014-1024` | [code] |

---

## 4. Low severity and polish

- `showToast(message, 'error')` is called in about 8 places, but the second parameter is an *action object*, so the "error" styling never exists (`app.js:2384, 2675, 2739, 4613, …`).
- Maskable icon is byte-identical to `icon-512.png` (same MD5), so Android crops the logo. Make a real maskable icon with safe-zone padding.
- `apple-mobile-web-app-capable` is deprecated; add `mobile-web-app-capable`. The login copy says "Enter your passphrase" but asks for a username too. The login inputs use placeholders as labels.
- Reading-goal settings are saved but never shown anywhere: no progress ring, no streak toward the goal.
- TTS rate, voice and pitch are not persisted. The sleep-timer `<select>` still shows "10 minutes" after the timer ends or TTS stops.
- Deep links (`#/library`, `#/book/<id>`) are pushed to history but not restored on reload.
- `renameCollection` uses `prompt()` while the rest of the app uses styled dialogs.
- Book details shows "0.0 MB" for small files; the desktop details modal has no rating control.
- Library cards: the "…" menu button overlaps the placeholder-cover title ("Three Chapter Test B…"). Placeholder covers render differently on Home (centred, styled) and Library (cramped, top-left).
- Home shows the same books in "Recently added" and "Unread" side by side when the library is small. The Library page prints the book count twice.
- Mobile book details: "Remove book" (destructive) has the same styling as neutral rows. Rating and description sit below the fold under the tab bar.
- Contrast (Impeccable detector, verified in the DOM): light-shell `.new-collection-btn` (Create, Close, Save goals, Add account…) and the TTS play button render `#201C16` on `#4E7162` = **3.1:1**, failing WCAG AA 4.5:1.
- `.tts-pulse` infinite pulsing dot is decorative motion; the global reduced-motion rule uses the `0.01ms` kill pattern.
- `ARCHITECTURE_AND_SOURCE.md` is a 1 MB generated snapshot (header dated 23 Sep) that is already stale versus the code; it doubles repo size and goes out of date on every change. Generate it in CI or drop it. The dated `docs/*.md` audit notes should be consolidated.
- DEPLOY.md calls the admin screen "Admin Settings"; the UI says "People & permissions". The cron `tar` of a live WAL database is not crash-consistent (use `sqlite3 .backup` first).
- `login` opening a new session never revokes old ones; sessions last 90 days with no sliding refresh or idle timeout.
- `GET /api/highlights` loads all rows and filters in JS. Fine for a household, but there is no pagination.
- The shelf re-renders every card (with cover images) on each rating or status change; no virtualisation for libraries in the thousands.
- Settings API accepts unlimited keys (each up to 100 KB) per user.
- `/api/export` is `app.all`, so it accepts GET. Fine given SameSite=Strict, but make it explicit.

---

## 5. Frontend and UI assessment (Impeccable audit)

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 3/4 | Strong keyboard and focus work (focus traps, roving radios, ARIA states, 0 mobile touch targets under 44 px); primary-button contrast fails AA in the light shell; placeholder-only login labels |
| 2 | Performance | 3/4 | Thoughtful caching (LRU blobs, IndexedDB CFI index, Range support); full shelf re-render on each change; a 250 KB monolithic `app.js` |
| 3 | Theming | 2/4 | Tokens exist, but app.css/ui.css layer overrides and hard-coded colours (about 40 in the mobile block); reading themes are dark-only |
| 4 | Responsive | 3/4 | Separate desktop and mobile shells both work, with no horizontal scroll at 375 px; desktop reader chrome behaviour is touch-first |
| 5 | Implementation integrity | 2/4 | Coherent visual identity, but two parallel shells (`mobile.js` renderers reused by `ui.js`), three CSS layers, inline handlers, and global mutable state across 5 scripts |
| **Total** | | **13/20** | **Acceptable**: the product feels designed; the debt is structural |

**What is working well:** a distinctive editorial identity (Instrument Serif and DM Sans, green and gold), real offline engineering, careful race handling (`accountVersion`, request tokens, abort controllers), reduced-motion support, and good e2e coverage of keyboard and touch behaviour.

**UI improvements worth making:**
1. **Reader:** add light and sepia themes; desktop hover-reveal of controls (keep them visible while the pointer is over a bar); visible prev/next affordances on desktop; a real back button; show the book title in the top bar; reserve space so the bar doesn't cover text; a larger font-size stepper.
2. **Library:** unify placeholder covers; move the card menu off the title; add a list/table view on desktop for big libraries; show "x of y in series" and reading status badges; empty and filtered states with clear "reset filters".
3. **Home:** deduplicate rails; add a goal-progress card (goals already exist); a "Recently highlighted" rail.
4. **Book details:** render a sanitised description (paragraphs, not tags); rating in the desktop modal; human file sizes (KB); clearly separate destructive actions.
5. **Forms:** replace every `prompt()` with the in-app `openFormEditor` (collection picker with search and create, series editor, rename).
6. **Theming:** collapse `app.css` and `ui.css` into one token layer; replace hard-coded mobile colours with tokens; respect `prefers-color-scheme` for the default shell theme (it currently defaults to dark after login and light at the login gate).
7. **Login:** visible labels, a show/hide passphrase toggle, a caps-lock warning, correct copy.

---

## 6. Essential features to add

**Reading experience**
- Light, sepia and white page themes; justification and hyphenation toggle; a two-page spread toggle; font weight; per-book overrides.
- Store full highlight text; bookmark rename and notes; highlight export for the whole notebook (Markdown, CSV, Readwise-compatible JSON).
- Persist TTS voice, rate and pitch; a "continue reading aloud across chapters" status; media-session controls for the lock screen.
- Opt-in dictionary with a self-hostable option; Wikipedia lookup.

**Library**
- Cover upload/replace and metadata fetch (Open Library / Google Books by ISBN).
- OPDS catalogue feed so KOReader, Moon+ and Apple Books can browse and download.
- Calibre library import (bulk); duplicate detection by title/author, not just file hash.
- "Want to read" shelf, per-user tags, and full-text search across the whole library.
- Pagination or virtualisation for big libraries.

**Accounts and security**
- Self-service passphrase change; an active-sessions list with "sign out everywhere"; session idle timeout.
- Optional TOTP for admins; audit log of admin actions (deletes, imports, role changes).
- Hashed session tokens; HTTPS-aware secure cookies by default.

**Stats and goals**
- Visualise goals (daily ring, yearly books); a reading calendar heatmap; per-book time; year-in-review.

**Operations**
- Working Docker image (C1) with a healthcheck-verified CI smoke test; GitHub Actions running unit, e2e and `npm audit`.
- Scheduled full-library backups (DB plus files) with retention; restore preview (dry-run report) before import.
- Structured logging (H3), a `/metrics` endpoint, and a configurable rate limit.
- Express 5 / better-sqlite3 13 upgrade path.

---

## 7. Recommended order of work

1. **Done in pass 2:** C1–C5 (uncommitted). **Next:** commit them, build and run the Docker image once, and remove the inline handlers so `'unsafe-inline'` can be dropped.
2. **This week:** H1 session lifecycle, H2 deployment docs and cookie defaults, H3 logging, H4 full highlight text.
3. **Next:** H5 light themes, H6 dictionary opt-in, H7 and the M-series, each with a regression test.
4. **Then:** the UI refinements in §5 and the features in §6, starting with self-service passphrase change, OPDS, cover editing, and goal visualisation.
