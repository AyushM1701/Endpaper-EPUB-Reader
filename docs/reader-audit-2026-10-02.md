# Endpaper reader audit — 2 October 2026

The reader has functional problems below the UI styling layer. The most urgent are blocked desktop wheel scrolling, unreliable control restoration, and phone gestures that depend on iframe callbacks WebKit blocks. Preserve the existing Apple Books-like mobile appearance while correcting these mechanisms.

## Scope and evidence

Inspected reader layout creation, scrolling, pagination, iframe input, immersive controls, keyboard routing, contents navigation, search, bookmarks, highlights, notes, export, speech playback, and PWA update/asset handling. Used the Impeccable audit workflow and systematic debugging. These findings concern the current working tree, including the existing UI changes, rather than only the last committed revision.

User reports: desktop scrolling fails in **Scrolling** mode; page turns fail for every book in both Safari and the Home Screen app on an iPhone 16, with iOS 27 reported by the user.

Runtime diagnostics use an isolated server on port 39139, a temporary database, and a generated EPUB with a long chapter. The live library, account, server on port 3001, and real reading positions were not used for these tests. Desktop viewport: 1440 × 900. Phone viewport: 393 × 852 with touch enabled. Chromium and Playwright WebKit run on Windows; these are not physical iPhone tests. Speech and annotation responses are substituted only where needed to reproduce timing and state failures.

**No production reader fixes were made during this audit.** Added diagnostic tests outside the regular e2e test directory. Some deliberately fail against today's behavior; others compare two controlled conditions to isolate a cause. Previous production UI changes remain in the working tree.

## Prioritized findings

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| R01 | P1 | Chromium cannot wheel-scroll over EPUB text | Native wheel reproduction and CSS A/B |
| R02 | P1 | Desktop text clicks cannot restore hidden controls | Native click reproduction and missing input binding |
| R03 | P1 | WebKit blocks iframe gesture callbacks | Native input, browser console, sandbox A/B |
| R04 | P2 | Edge detection uses chapter width instead of visible page | Measured geometry and handler A/B |
| R05 | P2 | Hidden controls change edge taps into reveal-only taps | Native touch reproduction and branch order |
| R06 | P2 | Changing a search query can leave “Searching…” indefinitely | Delayed-index race reproduction |
| R07 | P2 | Copy and Share lose most of a long selection | Actual DOM selection through the action text pipeline |
| R08 | P2 | Read Aloud starts from an earlier, invisible page | Later-page reproduction with captured speech queue |
| R09 | P2 | Stop does not cancel a pending audio continuation | Playback callback/timer reproduction |
| R10 | P2 | A layout switch discards pending annotations | Controlled delayed-response reproduction |
| R11 | P2 | Failed annotation edits silently leave false UI state | Failed-delete reproduction; related edit paths reviewed |
| R12 | P2 | Export includes successfully deleted highlights | Successful-delete state reproduction |
| R13 | P2 | Phone selection toolbar extends outside the screen | Runtime bounding-box measurement |

P1 means a core reading action is blocked. P2 means an action produces unreliable or misleading results, or a control becomes inaccessible.

### R01 — Desktop wheel input is trapped inside the book iframe

**Location:** `public/app.js:1028`, `applyReaderContentStyles`; `public/app.js:1518`, `tuneScrollContainer`.

The EPUB's `html` and `body` receive `overscroll-behavior: none !important`. The long iframe expands to the chapter's content height, while the outer EPUB manager owns scrolling. In Chromium, a wheel gesture over the iframe cannot chain to that outer container.

Native wheel input left the outer scroll position at 27 pixels. In a test-only comparison, changing the iframe rule to `auto` made the same wheel input move the outer container to 627 pixels. With controls already hidden, native wheel input also remained stuck at 400 pixels. WebKit scrolling passed with the same book; the failure is browser-dependent.

**Fix direction:** allow book input to reach the owning scroll container. Keep page-level overscroll containment on the reader boundary instead of applying it indiscriminately to the expanded EPUB document. Verify wheel, trackpad, keyboard, and touch with controls both visible and hidden.

### R02 — Desktop has no complete click path for immersive controls

**Location:** `public/app.js:1213`, wrapper click listener; `public/app.js:1218`, iframe input hooks; `public/app.css:1754`, tap-layer default.

The wrapper has a click listener, but iframe clicks do not bubble into the parent wrapper. The EPUB document hooks bind touch and keyboard input, without a mouse click handler. The immersive tap layer is enabled only under the mobile CSS rules.

After scrolling hid the controls, a native desktop click on the chapter text left `#app.chrome-hidden` unchanged. This is separate from R01: even a browser that scrolls correctly can leave the user without a reliable way to restore the controls.

**Fix direction:** route desktop reader clicks explicitly, with selection and link guards. Keep mouse and touch behavior consistent: reading hides chrome; a center click/tap restores it; interaction with selected text or links should not toggle it accidentally.

### R03 — Safari/WebKit cannot run the iframe input callbacks as currently configured

**Location:** `public/app.js:939`, `renditionOptions`; `public/app.js:1218`, `registerSwipeGestures`; iframe creation in `public/epub.min.js`.

The bundled EPUB renderer creates a `srcdoc` iframe with `sandbox="allow-same-origin"`, without script permission. In WebKit, native touch/click input produced no parent-installed iframe callbacks and logged a sandbox script-execution error. A test-only rerender of the trusted generated fixture with EPUB.js's `allowScriptedContent: true` changed a native click callback count from zero to one. This isolates the sandbox restriction.

This matches [WebKit issue 218086](https://bugs.webkit.org/show_bug.cgi?id=218086), which describes parent event listeners being blocked in same-origin sandboxed `srcdoc` frames. It is a strong explanation for the shared Safari/Home Screen gesture failure, though the exact physical iPhone behavior remains to be verified.

**Fix direction:** design an input path compatible with WebKit while preserving EPUB script isolation and text selection. Do not ship the test's script-permission change as a quick fix: combining same-origin and script permissions has sandbox escape implications documented in the [HTML iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox). A parent-owned input surface or carefully isolated rendering approach needs to be tested with native selection, links, annotations, and assistive input.

The navigation engine itself worked in the fixture: direct page turns and native taps precisely on the Next button advanced within the long chapter. Thus the physical-device report of failing Next/Previous controls is still an acceptance-test requirement; the audit does not claim to have reproduced failure of every button path.

### R04 — Edge-tap coordinates describe the whole chapter

**Location:** `public/app.js:1246`, iframe width passed to `handleReaderSwipeOrTap`.

The phone's visible page was 393 pixels wide; the columnized chapter iframe was 14,541 pixels wide. The handler uses `iframe.window.innerWidth` to choose left/right quarters. A tap at x = 330, near the visible right edge, is classified against the entire chapter width. The controlled comparison left the CFI unchanged with width 14,541 and advanced it with width 393.

**Fix direction:** classify input against the visible reader viewport. Translate iframe coordinates using its position and the reader container's position, including later pages where the iframe has moved left. Merely substituting `window.innerWidth` without coordinate translation will not cover all pages.

### R05 — Edge gestures change meaning when controls hide

**Location:** `public/app.js:1085`, immersive branch; `public/app.css:1496`, coarse-pointer navigation buttons; `public/app.css:1746`, hidden navigation zones.

The clean-tap handler reveals hidden controls and returns before checking page edges. A native edge tap with immersive mode enabled restored chrome but did not advance the CFI. Phone Next/Previous buttons also occupy only a 48 × 64 pixel area near mid-height, with invisible arrows under the mobile styling. Tapping another point along the side depends on the broken iframe gesture path.

**Fix direction:** agree on a stable gesture contract: center tap reveals controls; edge tap turns the page in either chrome state; horizontal swipe turns pages. Provide discoverable, keyboard-accessible Previous/Next controls when chrome is visible. Preserve the quiet mobile design without making usable hit areas ambiguous.

### R06 — Search cancellation contaminates the shared index

**Location:** `public/app.js:2725`, `getBookTextIndex`; `public/app.js:2795`, `runSearch`.

The cached indexing promise captures the first query's cancellation predicate. A replacement query reuses that promise. Once the original query becomes stale, the index resolves to `null`; the replacement search returns without clearing its “Searching…” status. Delaying a section load by 700 ms and changing queries after 50 ms reproduced the stuck state.

**Fix direction:** separate book indexing lifetime from individual query lifetime. Cancel stale result rendering independently; handle canceled/failed indexing explicitly and keep the latest query able to finish.

### R07 — Copy and Share use the truncated highlight excerpt

**Location:** `public/app.js:2532`, selection context; `public/app.js:5450`, `selectionText`.

Selection handling truncates text to 140 characters plus an ellipsis for the highlight excerpt. Copy and Share then read that excerpt as the actual selected text. A selected 558-character paragraph yielded only 141 characters in the action pipeline.

**Fix direction:** retain the full selection separately from the list preview excerpt. Copy/Share must preserve the full selection; highlight rows may still display a shortened preview.

### R08 — Read Aloud chooses a block using only its vertical position

**Location:** `public/app.js:4762`, `startTtsFromVisible`; `public/app.js:4399`, audio highlighting/navigation.

The visible-block search tests `rect.top` and `rect.bottom`, but not horizontal visibility or the iframe's offset in the outer scrolling viewport. Earlier columns can satisfy that test while being off-screen. After three page turns, the captured first audio item was still “Chapter One.” This reproduced in Chromium and WebKit; no actual voice playback was required to inspect the chosen queue.

**Fix direction:** start from the current CFI or intersect block rectangles with the visible reader viewport in both axes. Keep the audio queue tied to the active book/section. Also audit end-of-section continuation: the current code calls `turnPage('next')`, which advances one page, then rebuilds a queue from the beginning of the active document; that can replay text rather than move to the next chapter.

### R09 — Audio can restart after Stop

**Location:** `public/app.js:4529`, page-turn continuation and 350 ms timer; `public/app.js:4603`, `stopTts`.

The continuation waits for a page turn and schedules a delayed queue rebuild. Stop cancels speech and clears the queue, but does not cancel that pending continuation or invalidate its session. A controlled playback callback followed by Stop produced one subsequent `startTtsWithQueue` call.

**Fix direction:** give playback a session/generation identifier and cancel pending timers and continuations. Stop, book changes, layout changes, and account changes must invalidate the session. Replace timing guesses with awaited section/render readiness.

### R10 — Switching layout during annotation loading hides saved data

**Location:** `public/app.js:949`, `setLayout`; `public/app.js:1857`, annotation response guard.

Annotation fetching captures the original rendition. A layout switch replaces it, so otherwise valid responses for the same book are discarded. The replacement layout applies only annotations already in memory and does not refetch them. Releasing a saved bookmark and highlight after switching layouts left both arrays empty.

**Fix direction:** scope annotation data loading to the active account/book, separately from applying it to a particular rendition. A valid response should update the book model and apply to the current renderer; another book/account's response must still be rejected.

### R11 — Failed bookmark/highlight edits can look successful

**Location:** `public/app.js:2624`, recolor; `public/app.js:2675`, delete; bookmark removal paths around `public/app.js:2347` and `public/app.js:2437`.

The reader changes local state first, then uses raw API calls whose failures are only logged. A simulated failed highlight deletion removed the item from the visible model without restoring it or presenting a retry state. Reopening can make the server's old item reappear. Related recolor/bookmark removal paths have the same persistence gap by inspection. Creation uses a different resilient request path.

**Fix direction:** use a consistent mutation contract: acknowledged save, or a visible pending operation that can retry. Roll back unsuccessful optimistic changes if they are not queued. Avoid silently representing an unsaved edit as permanent.

### R12 — Export uses an obsolete highlight array

**Location:** `public/app.js:1862`, global alias; `public/app.js:2682`, array replacement on delete; `public/app.js:4908`, export.

`window.currentHighlights` initially aliases `entry.highlights`. Deletion replaces `entry.highlights` with a filtered array, leaving export pointed at the old array. A successful deletion left zero visible highlights but one in the export source.

**Fix direction:** export from the current book's canonical annotation model and remove the redundant global snapshot.

### R13 — The selection toolbar does not fit a phone

**Location:** `public/index.html:456`, popup actions; `public/app.css:764`, popup flex layout; `public/ui.css:261`, mobile swatches; `public/app.js:2560`, positioning.

The popup is a single flex row with color swatches and Listen/Note/Define/Copy/Share/Remove actions. Center positioning clamps the anchor but ignores the popup's measured width. On a 393-pixel viewport, the existing-highlight popup measured 544 pixels wide and began at x = −75.5. Actions extend outside both screen edges. Larger touch targets in the recent UI work exacerbate this layout problem.

**Fix direction:** use a compact mobile action sheet or a constrained multi-row popup, then position using the actual dimensions and available viewport/safe-area space. Keep desktop's contextual presentation while sharing action labels, colors, and behavior.

## Consistent reader behavior to implement

| Context | Reading input | Control restoration | Page turn |
| --- | --- | --- | --- |
| Desktop, scrolling | Wheel/trackpad scroll the outer reader over any text | Click unselected text; keyboard access remains available | Page navigation is not overlaid on scrolling text |
| Desktop, paginated | Mouse selection and EPUB links retain native behavior | Center click and explicit toolbar access | Visible buttons and keyboard shortcuts |
| Phone, scrolling | Native-feeling vertical movement without interception by menus | Center tap; selection keeps relevant tools available | No accidental horizontal page turns |
| Phone, paginated | Select text without triggering navigation | Center tap in either state | Side taps and horizontal swipes work with chrome visible or hidden |
| Drawers/popups/audio | Controls remain visible while interacting | Predictable close and focus return | Reading shortcuts do not steal form/control input |

Fix input and scrolling before further visual changes. The first implementation batch should address R01–R05 together, with one consistent gesture/state model. Then address search and annotation state (R06–R07, R10–R12), audio (R08–R09), and the selection popup layout (R13). Mobile typography, palette, shelf design, and Apple Books-like visual direction do not need to be replaced.

## Test coverage gaps and validation

The ordinary e2e suite passing earlier did not rule these failures out. Tiny chapters mostly test section transitions; they do not exercise long, columnized chapters. Direct function calls and dispatched synthetic events can bypass native iframe restrictions. WebKit on Windows is useful evidence, but does not replace installed iPhone testing.

Required acceptance checks after fixes:

- Chromium desktop: wheel/trackpad over text, controls visible/hidden, scrollbar and keyboard; center-click restoration after scrolling.
- WebKit and physical iPhone Safari/Home Screen: native swipes, edge taps at multiple heights, long chapters, later pages, chapter boundaries, rotation, and persisted reopening.
- Selection: long press/drag, links, highlight clicks, native handles, Copy/Share full text, constrained popup, font enlargement.
- Search: fast query replacement, slow indexing, clearing a query, layout changes, book changes, and failures.
- Annotations: delayed loading while changing layout; create/edit/delete offline or during failed requests; retry, reopen, and export consistency.
- Audio: visible-page start, pause/resume/Stop, section boundaries, pending continuation during book/layout changes, and real iPhone voice behavior.
- PWA: actual standalone launch, update activation, offline reopen, and device safe areas. SW/HTML versions are currently coherent; no evidence establishes stale PWA assets as the cause of the reported gestures.

## Reproducing the diagnostics

Run from the `server` folder. These tests are intentionally outside `test/e2e` and assert desired behavior, so failures are expected until fixes land.

```powershell
npx playwright test -c test/reader-audit/playwright.config.js
$env:READER_AUDIT_BROWSER='chromium'
npx playwright test -c test/reader-audit/playwright.config.js -g 'desktop.*wheel|scroll-chain|visible later page|full selected'
Remove-Item Env:READER_AUDIT_BROWSER
```

Final verification:

| Run | Result | Meaning |
| --- | --- | --- |
| WebKit: all 18 diagnostics | 11 expected-behavior failures, 7 passes; 57.6 s | Reproduces control restoration, native edge taps, search, selection, audio, annotation, export, and popup failures; confirms working direct/button navigation and controlled comparisons |
| Chromium: 5 focused diagnostics | 4 expected-behavior failures, 1 pass; 19.5 s | Reproduces wheel failure in both chrome states, truncated selection, and incorrect audio start; CSS A/B restores wheel scrolling |

The diagnostics are not a passing regression suite. Their red assertions preserve the failure conditions for implementation; passing comparisons isolate causes rather than certify the current reader.

Implementation follow-up: [reader-implementation-2026-10-02.md](reader-implementation-2026-10-02.md) records the fixes, review, and production regression results. The evidence above describes the original audit baseline.

Evidence logs:

- `C:\Users\AYUSH\Documents\EndpaperRecovery\reader-audit-webkit-final.log`
- `C:\Users\AYUSH\Documents\EndpaperRecovery\reader-audit-chromium-final.log`

Test output artifacts go to `C:\Users\AYUSH\Documents\EndpaperRecovery\reader-audit-results`. Earlier diagnostic output was moved to `reader-audit-initial-results` in the same recovery folder. No real user database was reset or migrated. Physical iPhone Safari and Home Screen validation remains outstanding.
