# Reader audit implementation — 2 October 2026

Spec: `docs/reader-audit-2026-10-02.md`. Work stays on the existing `codex/ui-consistency` branch and preserves prior UI changes. Baseline files saved in `EndpaperRecovery/reader-fix-baseline-20261002`.

## Tasks

- [x] R01–R05: restore native scrolling and unify desktop/touch input, viewport coordinates, hidden-control behavior, and visible navigation. Preserve native selection and EPUB script isolation. Verify long chapters and malicious EPUB content in WebKit/Chromium.
- [x] R06–R07, R10–R12: separate indexing from search cancellation, preserve full selection text, separate annotation loading from renderer lifetime, acknowledge annotation edits, and export canonical data. Verify delayed and failed operations.
- [x] R08–R09: derive audio start from visible text, cancel stale playback continuations, and advance to the next section without replaying the current one. Verify Stop and book/layout changes.
- [x] R13: constrain the contextual popup on phones, retain the existing visual design, publish coherent asset versions, run reader regressions and the complete suites, and obtain a fresh code review.

## Decisions and progress

- Existing audit reproductions establish RED for the reported failures. Promote them into regression coverage and replace cause-isolation experiments with behavioral assertions.
- Input, annotation, and audio changes share `public/app.js`; implement inline to avoid concurrent edits. A fresh reviewer will inspect the complete patch.
- Keep live user data untouched. All automated uploads, accounts, and bookmarks use temporary e2e databases.
- Physical iPhone Safari/Home Screen testing cannot be performed by this Windows harness; record that limit explicitly after browser verification.

## Implemented behavior

| Findings | Change |
| --- | --- |
| R01–R02 | Native iframe wheel input chains to the outer scrolling reader. Mouse clicks explicitly restore controls; selection and link interactions retain their native paths. Removed the manual touch/wheel overlay. |
| R03 | WebKit parent input callbacks work with EPUB.js script permission, while a CSP installed before content denies book scripts. Active EPUB nodes and attributes are neutralized in both content and serialization hooks. Inert body/SVG element slots preserve existing CFI addresses. |
| R04–R05 | Touch and mouse coordinates use the visible reader viewport, including later columns. Side taps turn pages with controls visible or hidden; center taps control chrome. Previous/Next arrows are visible when controls are shown. |
| R06–R07 | Book indexing outlives individual queries; results stay valid across layout changes but reject stale books/accounts/queries. Copy and Share use the complete selection. |
| R08–R09 | Audio starts from the selection/current CFI and its character offset. Section continuation awaits real navigation. A playback generation rejects callbacks after Stop, Pause, book/account changes, or layout changes. |
| R10–R11 | Annotation loading and acknowledged mutations update the current book independently of the original rendition. Failed deletes/recolors retain saved state and show a retry message. Bookmark/highlight/note creation survives layout changes. |
| R12 | Markdown export reads the current book model; removed the obsolete global highlight snapshot. |
| R13 | The selection popup wraps within the available visual viewport and clamps its measured dimensions. Resize/viewport changes reposition it. |

Mobile typography, palette, shelf presentation, and Apple Books-like direction are preserved. HTML and service-worker assets share version `v15.2.0-20261002`.

## Review and regressions

One fresh independent review found four important issues in the initial patch: removed body elements shifted existing CFIs; search still captured the old rendition; audio discarded range offsets; creation acknowledgements were discarded after a layout change. Five reproductions failed before the final fix pass. The fixes preserve inert element slots, bind search and data to the account/book, and retain range offsets. Additional regressions cover actual search-result navigation after layout replacement, both selection and CFI audio offsets, note acknowledgements, and Stop while the next section is still rendering.

Tests use generated long chapters, temporary accounts/databases, and an isolated server on port 39137. API/speech timing substitutes test pending/failure behavior; wheel, clicks, edge taps, and rendering use the browser. Malicious head/body/SVG markup and dynamically inserted scripts remain blocked while native parent callbacks execute.

The dated audit remains a record of the original failure evidence; `server/test/e2e/reader-regressions.spec.js` is the production regression suite.

## Final verification

| Check | Result |
| --- | --- |
| Full e2e suite, WebKit | 52 passed, 1 existing skip; 1.9 minutes |
| All reader regressions, Chromium | 28 passed; 30.7 seconds |
| Server tests | 4 passed, no failures |
| JavaScript syntax and `git diff --check` | Passed; Git only reports existing LF/CRLF normalization warnings |
| Visual inspection | Desktop paginated/scrolled reader and phone selection popup inspected; popup actions fit within the phone viewport |

The skipped test is cold offline restart in Windows WebKit. Physical iPhone 16 Safari and Home Screen launch, native swipe/selection handles, rotation/safe areas, real speech output, and device update activation remain device acceptance checks. Windows browser tests do not certify these hardware-specific paths. No live library/account/progress data was modified; changes remain local on the existing branch.

Logs: `C:/Users/AYUSH/Documents/EndpaperRecovery/reader-final-full-e2e.log`, `reader-final-chromium.log`, and `reader-final-server-tests.log`. Visual captures are in `EndpaperRecovery/reader-final-visuals`.

To load the new assets, leave the reader and refresh Endpaper. In the phone app, use More → Check for updates and apply an available update outside the reader.
