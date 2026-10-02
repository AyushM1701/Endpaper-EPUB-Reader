# Endpaper UI analysis and improvement direction

Audit date: 2 October 2026. Code baseline: `main`, commit `99ce4a9`.

## Conclusion

Preserve the current mobile design and make it the visual reference for Endpaper. Desktop needs a clearer library structure, cover-led browsing, stronger action hierarchy, and a calmer reader toolbar. Contents, search, bookmarks, highlights, notes, and read-aloud need one shared family of components across both layouts.

The central problem is design divergence. Mobile has a warm, coherent reading experience layered over an older desktop application. Several secondary tools still use that older presentation. Some inconsistencies come from actual markup/CSS mismatches and different behavior, rather than subjective styling preferences.

This document is analysis and a proposed direction. No application UI code was changed.

## Scope and evidence

Reviewed:

- The supplied desktop screenshot, including its larger collection, repeated truncated titles, discovery shelves, and prominent horizontal scrollbar.
- The running local application: desktop shelf, book details, reader, contents, in-book search, and bookmark empty state; narrow-screen home, library search, book details, reader menu, and settings.
- `public/index.html`, `public/app.css`, `public/app.js`, `public/mobile.js`, README architecture, and the existing browser-test coverage.
- A static design scan and relevant W3C guidance.

Limits:

- The local library available during inspection contained four books; the supplied screenshot remains the evidence for a larger desktop library.
- Narrow-screen inspection used a 393 × 852 desktop-browser viewport. It verifies narrow layouts, but does not emulate an iPhone's coarse pointer, virtual keyboard, safe areas, or installed Safari behavior. Touch-specific sheet behavior was inspected in source.
- Populated annotation rendering and audio controls were reviewed in source. No new bookmarks or highlights were created, and speech playback was not started.
- No full accessibility conformance claim, performance benchmark, or usability study is made.
- Existing reader font, font-size, layout, and theme preferences were respected. The large text visible in the inspected reader is not evidence that the default reading typography should be replaced.

## What should be preserved

1. **Mobile identity:** warm near-black surfaces, cream text, muted gold accents, editorial serif headings, and a calm reading atmosphere.
2. **Mobile navigation:** Home, Library, Search, and More; familiar placement and current floating bottom navigation.
3. **Cover-led discovery:** actual EPUB artwork, consistent cover proportions, and the mobile home page's focused continue-reading card.
4. **Mobile reader:** unobtrusive floating controls, immersive reading, the current tool-menu concept, and the newer Themes & settings presentation.
5. **User control over reading:** existing page themes, fonts, sizing, spacing, paginated/scrolled layouts, gestures, and bookmarks.
6. **Existing behavior worth retaining:** private per-account reading state, explicit offline downloads, role-aware management tools, keyboard shortcuts, and coherent service-worker shell updates.

Consistency should mean the same visual vocabulary and predictable behavior. It should not force desktop to use phone-sized navigation or force mobile to carry a desktop sidebar.

## Why desktop currently feels weaker

### Browsing begins without a clear page hierarchy

The screenshot begins with four equal continue-reading cards, then Recently added, Your series, Unread, and Finished. The full library and its search/filter controls come later. A person looking for a specific book must navigate past discovery content before reaching the catalogue controls.

Source: `public/index.html` places `continue-card` and `smart-sections` before `shelf-header`; `public/app.js:5011` builds the discovery sections.

**Recommendation:** separate Home from Library on desktop, matching mobile's existing distinction. Home is for returning to reading and discovering books. Library is for the complete catalogue, with search, filters, sorting, and view controls immediately visible.

### Most discovery cards omit the strongest identifier: the cover

Desktop smart shelves render title/author buttons without cover art. Mobile renders covers. In a library of long fantasy titles or several volumes of the same series, a short truncated title makes items difficult to distinguish. The supplied screenshot demonstrates this with several visually similar “He Who Fights with…” cards.

Source: `public/app.js:5002` versus `public/mobile.js:75` and `public/mobile.js:110`.

**Recommendation:** use cover-led cards for Recently added, Unread, and Finished. Display up to two lines of title and one line of author. Include a series/volume subtitle when it helps distinguish similar titles. The full title must remain available in details and accessible naming.

### Desktop and mobile use different palettes and geometry

Desktop dark tokens use `#12151A` and `#1A1E25`, a cooler appearance. Mobile uses `#171714` and `#292821`, with warm gold and cream. Desktop's base radius is 3px; later components introduce 7px, 10px, 12px, pills, and large mobile sheets independently.

Source: `public/app.css:7`, `public/app.css:27`, `public/app.css:1790` onward.

**Recommendation:** derive desktop dark appearance from the mobile palette. Define component-level radii and surface roles so a book detail, reader panel, search field, and settings control belong to the same application. Keep the light appearance as a deliberate corresponding theme.

### Controls have weak grouping and priority

The desktop library toolbar combines search, collection filter, sort, density, statistics, notebook, selection, and administration. The reader toolbar adds contents, search, settings, two bookmark-related icons, speech, fullscreen, more tools, help, appearance, logout, and administration.

**Recommendation:** distinguish navigation, task controls, and account controls. Reading tools should dominate the reader toolbar; account and catalogue administration should live in an account/More menu. Search and sorting should dominate the Library toolbar; management controls should remain secondary and role-aware.

### Equal-looking detail actions obscure the main task

The desktop book-details modal presents Continue reading, Download, Collections, Edit details, and Remove book as a group of similar buttons. Mobile gives reading a clear primary action and places secondary tasks below it.

Source: `public/app.js:5321`, `public/app.css:1751`; compare `public/mobile.js:373` onward.

**Recommendation:** use the mobile hierarchy on desktop: cover and title, one primary Read/Continue action, then progress/status and optional secondary actions. Put destructive management actions in a clearly separate area.

## Verified inconsistencies and priority

P1 means significant discoverability, accessibility, or behavior difficulty. P2 means a visible inconsistency or friction with a workable path. P3 means refinement. No P0 task blocker was established in this review.

| Priority | Finding | Evidence | Recommended correction |
|---|---|---|---|
| P1 | Desktop catalogue search is below discovery shelves | Screenshot; `index.html` shelf order | Separate Home and Library; keep catalogue controls at the top of Library |
| P1 | Search result markup does not match its styling | `app.js:2825` emits `.search-result`, `.search-chapter`, `.search-excerpt`; CSS at `app.css:959` targets `.search-result-item` and `.search-result-excerpt` | Establish one result-row contract and remove obsolete selectors |
| P1 | Highlight excerpt and color-marker markup lack the intended CSS | `app.js:2717` emits `.highlight-excerpt` and `.highlight-swatch`; `app.css:940` targets `.highlight-text`, `.highlight-color-tag`, and other metadata not rendered | Use a shared annotation row with matching markup and styles |
| P1 | Selection color controls use a different class from the declared color-button styles | `index.html:437` uses `.swatch-btn`; `app.css:771` defines `.hl-color-btn` | Use one accessible swatch component with explicit size and selected state |
| P1 | Search/highlight navigation and bookmark destination text use click handlers on non-button elements | `app.js:2417`, `app.js:2714`, `app.js:2824` | Make destination controls real buttons/links; keep Remove/Edit as separate siblings |
| P1 | Inactive speech controls remain in the accessibility tree | Observed on both library and reader; `.hidden` at `app.css:813` only transforms/fades the player | Hide/inert the inactive player and synchronize this with playback state |
| P1 | Desktop panel headers can sit underneath the fixed reader toolbar | Observed Contents/Search/Marks headers; drawer z-index 30 at `app.css:536`, toolbar z-index 40 at `app.css:122` | Give panels a deliberate stacking/offset policy and a persistent visible close control |
| P1 | Narrow-shell and sheet breakpoints disagree | `mobile.js:23` activates on width/coarse-pointer combinations; `app.css:1770` makes sheets only for hover-none/coarse pointers | Use a common layout breakpoint; use pointer queries for interaction sizing, not incompatible shell structures |
| P2 | Desktop series cards open the first book instead of a series view | `app.js:5027` creates a representative first-book object; `smartBook()` opens that object; mobile `mobile.js:155` navigates to the series | Give both platforms the same series destination |
| P2 | Book activation differs by platform | Desktop `app.js:5095` opens the reader; mobile `mobile.js:98` goes to details | Choose one browsing activation rule; preserve a direct Continue-reading shortcut |
| P2 | The newer settings sheet and older Contents/Search/Marks panels have different visual systems | `app.css:1947` customizes Settings; other drawers retain the base presentation | Extract shared panel/header/body styles from the mobile settings treatment |
| P2 | Current chapter is visually highlighted only in a touch-specific CSS rule | `.toc-item.current` at `app.css:1777`; `app.js:2980` updates it on all devices | Provide the same selected-state vocabulary everywhere |
| P2 | Reading-state rules differ between discovery shelves | Desktop `app.js:4982`, `app.js:5017` use percentages; mobile uses `mobileReadingStatus()` | Share one status helper and preserve explicit user status |
| P2 | The mobile appearance toggle cannot restyle the hard-coded mobile shell surfaces | `mobile.js:609`; `app.css:1790` fixes the background/text | Either make appearance effective through tokens or make the setting's actual scope clear |
| P2 | Notes and metadata editing use browser prompts | `app.js:5366`, `app.js:5405`, `app.js:5415`, `mobile.js:535` | Replace with labeled in-app editors that match the existing mobile design |
| P2 | Reader highlights omit note/chapter/actions although the notebook can show richer data | `app.js:2701` versus `mobile.js:500` | Render a shared annotation model with quote, note, location, color, tags, and actions |
| P2 | Desktop Notebook opens the book without navigating to the selected highlight | `app.js:5400` versus mobile `mobile.js:525` | Open the associated book and navigate to its CFI on both platforms |
| P2 | Speech options disappear on touch layouts without an alternative options surface | `app.css:1768` hides voice, pitch, sleep controls | Add an Audio options panel; keep the player itself compact |
| P2 | Small gold text/white-on-gold controls can fail contrast requirements | Example token calculations below | Use contrast-safe text/action tokens while retaining the palette |
| P2 | Desktop action controls lack explicit filter/sort labels | `index.html:172` onward; density is labeled but filter/sort are not | Add accessible names and visible/contextual labels where useful |
| P3 | Shelf rails, gutters, and card density do not form one composition | Screenshot; `app.css:226`, `app.css:249`, `app.css:1740` | One content alignment grid, deliberate shelf widths, and restrained overflow treatment |

## Proposed desktop layout

### Navigation

Use a restrained desktop sidebar or navigation rail, with Home, Library, and Search as the primary destinations. Put Notebook, Downloads, collections, and reading insights in a secondary group. Keep account settings and administration at the bottom or inside More.

Mobile keeps its current four-tab navigation. The destination names and underlying state remain consistent even when their placement differs.

For a smaller desktop/tablet window, collapse the sidebar to a compact rail or top navigation. Do not force a sidebar into the phone layout.

### Desktop Home

- Begin with “Your reading,” using the mobile heading character and warm palette.
- Feature the most recently read book; show other in-progress books as quieter secondary items rather than four equally prominent cards.
- Follow with Recently added and Your series, using actual covers or a small cover stack for series.
- Make section-level “See all” links open the corresponding Library/series view.
- Keep optional Unread/Finished browsing compact. Do not repeat the entire catalogue below Home.
- Give the top area enough hierarchy to work with one, four, or many books.

### Desktop Library

- Page heading, total/filter count, and Add book action at the top.
- Search with enough width for a long title; filter and sort beside it on wide windows.
- Grid/list view control and compact/comfortable density as secondary options, not competing primary actions.
- Cover grid with consistent proportions, two-line titles, author, optional series/volume, and a subtle progress indicator.
- A book menu for contextual actions; ratings can remain in details rather than adding five permanent controls to every shelf card.
- Bulk-selection controls appear only after entering Select mode.
- Collections, backup tools, and account management retain existing role restrictions.

Suggested starting dimensions, to be validated rather than treated as fixed requirements: sidebar around 216–240px; page gutters 24–40px; covers around 140–170px wide in comfortable desktop browsing. Card widths should follow available space, not spread sparse content across the entire window.

### Book details

Use the same information model as mobile. At wide sizes, show the cover beside title/author/series and the primary reading action. Put description and shared metadata below, with progress/status, personal rating, downloads, and annotation links in a clear secondary grouping.

A desktop detail page or substantial detail panel is preferable to a small modal for long descriptions and several management actions. Keep modal/sheet use for short decisions and edits.

Preserve the current mobile detail page and improve only specific problems such as destructive-action separation and editing consistency.

## Shared reader-tool design

The useful reference is the existing mobile settings treatment: a clear heading, rounded surface, legible controls, and progressive disclosure. Extend its vocabulary to all reader tools without replacing the mobile reader itself.

Every reader panel should share:

- A stable heading and close control.
- A short context line when needed, such as the current book.
- A header that remains visible while results scroll.
- A separately scrolling body.
- The same spacing, typography, separators, control radius, and selected state.
- A defined empty/loading/error state.
- Reliable Escape, focus containment when modal, focus return, and accessible naming.
- A stacking policy above reader chrome, including the audio player and floating page-count controls.

Phone: sheet/floating-panel presentation that fits the current aesthetic and keyboard. Desktop: side panel or anchored popover according to task. Tablet: panel/sheet choice based on available reading space. Opening tools must not accidentally change page location or relayout the EPUB repeatedly.

### Contents

Use 15–16px UI text and comfortable rows. Distinguish chapter entries from nested sections through indentation and restrained hierarchy. Give the current entry both a visual indicator and `aria-current`. Keep the heading and close button visible when scrolling the current chapter into view; scroll the list body, not the entire panel.

Keep EPUB-provided navigation intact. The screenshot-like list of front matter, chapters, and license entries comes from publication content; presentation should organize it without inventing chapter numbers or deleting entries. For long books, collapsible nested groups can reduce scanning when the EPUB supplies that hierarchy.

### Search library and search book

Keep the scope explicit: “Search library” finds books; “Search this book” finds passages. Both use the same field shape, clear control, focus treatment, and status styling.

Library results should keep the successful mobile row: cover, readable title, author, and optional status/series. Desktop can show more columns without changing the row's identity.

In-book results should show chapter context, a short excerpt, and highlighted match text. Make the entire destination a keyboard-operable control. Keep the query visible while results scroll. Distinguish initial state, minimum query length, indexing/searching, results, no results, and failure. State an actual cap if results are limited; the current search implementation collects a bounded set rather than an unlimited result list.

On phones, reserve space for the virtual keyboard and ensure the focused field stays visible. Avoid shrinking the search field below the comfortable mobile input size.

### Bookmarks

Use a consistent saved-location row: chapter/location first, secondary progress/location metadata, then a separate overflow/remove control. Preserve access to creating a bookmark without conflating it with viewing saved bookmarks.

The current empty-state instruction mentions a ribbon in the top bar. That is unsuitable for the mobile reader where the action is in the tools menu. Use platform-appropriate instructions or a shared “Add bookmark” action.

Avoid a tiny underlined Remove link beside the primary navigation target. A clear separate action and undo feedback reduce accidental loss while remaining calm.

### Highlights and notes

Use the same annotation row in the reader and Notebook: excerpt, note when present, chapter/book context, color indicator, optional tags, and separate actions. Notes should be visible without requiring a separate trip to the global notebook.

Use a small color stripe or swatch rather than tinting the whole quote card. Quote typography may use the existing editorial serif, while metadata and buttons use UI typography. Do not force every long excerpt into italic text if it compromises reading.

The Bookmark/Highlight switch can use one segmented-control style shared with settings. Retain proper tab semantics and keyboard handling already present.

Notebook is a browsing surface, not a transient decision. Desktop should give it page-level space with search, filters, and book grouping. Mobile keeps the existing page.

### Selection actions

The selection popup currently exposes four color swatches plus Listen, Note, Define, Copy, Share, and sometimes Remove. It also uses mismatched swatch class names.

Prioritize Highlight, Note, Copy, and a More action. Keep other capabilities available rather than removing them. Show colors when changing/creating a highlight, with recognizable selection feedback. Use an in-app multiline note editor instead of a browser prompt. Position the menu relative to the selection with viewport/keyboard bounds, and preserve the EPUB's native selection behavior.

Do not create a second conflicting mobile selection interaction or break long-press handles merely to make the popup more decorative.

### Audio / read aloud

Treat this as read-aloud, not as a recorded audiobook. The current implementation uses browser speech synthesis and sentence navigation, so the interface should describe those capabilities accurately.

Keep a compact player with previous sentence, play/pause, next sentence, rate, and a clear options/stop affordance. Open voice and sleep timer in a matching Audio options panel. Pitch can be advanced. On desktop, show book/chapter or current passage context where space permits. On mobile, make the expanded options available instead of hiding them.

Use dynamic Play/Pause labels, visible paused/playing states, readable rate text, and clear unavailable/error feedback. Do not represent device-dependent voice availability as a uniform library of voices on every platform.

Define how the player coexists with page progress, the tools button, sheets, and the virtual keyboard. It must not cover the current reading controls. The inactive player must be absent from keyboard and screen-reader navigation.

No new audio engine is required for these presentation changes. Verify actual Safari/Chromium speech behavior separately before promising background playback or lock-screen support.

## Shared design system

Extract values already working on mobile; do not introduce a new visual identity.

| Role | Direction |
|---|---|
| App background | Warm near-black, starting from mobile `#171714` |
| Raised surface | Warm dark `#292821` family, with a separate overlay role |
| Primary text | Cream `#F5EFE5` family |
| Secondary text | Warm muted neutral with verified contrast |
| Accent | Muted gold for selected state and primary action, not every label |
| Page headings | Existing editorial serif character |
| UI labels and metadata | Existing system sans, with a documented scale |
| Reading typography | Existing user-selected reader fonts and settings |
| Spacing | A short shared scale such as 4, 8, 12, 16, 24, 32 |
| Radii | Explicit roles: field/button, card, sheet, floating control |
| Icons | One SVG vocabulary with consistent stroke and optical size |
| Motion | Short purposeful panel/state transitions, preserving reduced-motion support |

Use semantic token names for app surfaces, reader surfaces, text, borders, selected state, error, and disabled state. Keep app appearance separate from publication page theme while ensuring reader overlays inherit the page's palette predictably.

Standardize primitives: Button, IconButton, SearchField, SegmentedControl, SelectField, Cover, BookCard, BookRow, SeriesCard, AnnotationRow, ReaderPanel, Dialog/Sheet, EmptyState, StatusMessage, and AudioPlayer.

Each interactive primitive needs default, hover, focus, active/selected, disabled, loading, and error states where applicable. Make a small component catalogue with desktop/mobile and dark/light examples before converting every screen.

## Accessibility and contrast

The existing focus-visible outline, labels on many reader controls, inert closed drawers, current-chapter semantics, and keyboard shortcuts are useful foundations. These should survive the redesign.

Verified risks include non-keyboard destination rows, an invisible but accessible audio player, unlabeled selects, small secondary controls, and inconsistent panel layering.

Example solid-color calculations from existing tokens:

- `#A9803F` text on `#FFFCF6`: approximately **3.51:1**, insufficient for normal-size text.
- White on `#C9973F`: approximately **2.63:1**, insufficient for normal-size text, including the existing gold popup hover treatment.
- Mobile cream `#F5EFE5` on `#171714`: approximately **15.70:1**.
- Mobile muted text `#B9B0A2` on `#292821`: approximately **6.90:1**.

These are token-pair calculations, not a measurement of every composited/transparent surface. Preserve gold by using contrast-safe foreground/background combinations; do not discard the palette.

Normal text should meet 4.5:1 and large text 3:1 under [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Make mobile interactive targets comfortably around 44–48px. This comfort target is distinct from the WCAG 2.2 AA minimum of 24px or its applicable spacing exceptions, described in [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

Keep a visible focus state on every keyboard destination. Do not rely on a gold color change alone to communicate selection. Reader chrome must not obscure the focused close button or selected item.

The global reduced-motion override already exists. A later refinement can define explicit reduced-motion transitions for important state changes; it should not add decorative pulsing or elaborate page-load animations.

## Technical structure behind the design divergence

The frontend contains roughly 5,481 lines of application JavaScript, 2,012 lines of CSS, a separate 691-line mobile renderer, and 699 lines of shared markup. These figures do not themselves prove a problem. The concrete concern is duplicated rendering and progressively appended overrides.

Examples:

- Desktop `smartBook()` and mobile `mobileBookCard()` produce different book representations.
- Desktop and mobile implement separate home, details, and notebook views.
- Mobile filter options are added by mutating the desktop select's options.
- Status classification differs between discovery views.
- Several declared styles no longer match generated classes.
- Reader panel changes are scoped to Settings instead of a shared panel component.

Recommended implementation approach:

1. Define shared data/view helpers for status, search matching, series ordering, book activation, annotation destinations, and offline state.
2. Extract shared UI primitives and tokens while keeping the existing rendering system.
3. Add desktop presentation and navigation around those primitives.
4. Convert reader tools to the shared panel/row contracts.
5. Remove obsolete selectors and overrides only after their callers are accounted for.

A framework rewrite or backend redesign is not needed to achieve the requested UI quality. Keep EPUB loading, CFI navigation, annotation persistence, session authentication, and offline synchronization stable during presentation work.

## Recommended order of work

### Phase 1 — Stabilize the shared foundation

- Record the existing mobile screens as the reference.
- Establish palette, spacing, radius, type, icon, and state tokens.
- Fix the search/highlight/swatch class mismatches.
- Fix inaccessible result/annotation destinations and the inactive audio player.
- Align layout breakpoints and panel layering.

Result: the existing screens behave and style consistently before larger desktop layout work.

### Phase 2 — Bring desktop browsing to mobile quality

- Introduce desktop Home/Library/Search navigation.
- Replace text-only shelves with cover-led sections and useful series destinations.
- Build a clear Library toolbar and consistent book detail presentation.
- Unify status/activation rules and contextual book actions.

Result: desktop becomes a reading library with the mobile identity and predictable destinations.

### Phase 3 — Complete reader tools

- Contents, search, bookmarks, highlights, and settings use one panel system.
- Annotation rows and Notebook share content/behavior.
- In-app notes/tags editing replaces prompts.
- Read-aloud has a compact player and accessible options on every layout.

Result: the secondary screens feel as finished as the mobile library.

### Phase 4 — Refine and verify

- Check long titles, missing covers, empty libraries, large catalogues, loading/errors, offline states, and role differences.
- Refine spacing, hierarchy, truncation, and restrained transitions in one bounded visual pass.
- Test physical phone/installed Safari behavior and desktop keyboard use.
- Bump the shared service-worker build and asset versions together when shipping.

## Acceptance checks

| Area | Pass condition |
|---|---|
| Mobile preservation | Home/tab bar/cover proportions/reader controls retain the approved identity and interaction |
| Desktop Home | Clear page heading, focused continue-reading section, cover-led discovery, useful series navigation |
| Desktop Library | Search/filter/sort visible before catalogue browsing; grid and list keep readable identifiers |
| Long/duplicate titles | Two-line titles and useful volume context distinguish similar books; details show the full title |
| Cross-device behavior | Same status rules, series destination, bookmark meaning, and highlight destination |
| Panels | Heading/close always visible; body scrolls; Escape/focus return work; no chrome collision |
| Search | Initial/minimum-query/loading/result/empty/error states are distinct; result cap is described accurately |
| Annotations | Populated and empty states; quote/note/location/actions; keyboard navigation; correct CFI destination |
| Audio | Playing/paused/stopped/unavailable states; dynamic labels; options available; inactive controls unfocusable |
| Theming | Shell appearance and page theme have clear scope; every panel/control has readable light/dark combinations |
| Responsive | Narrow mouse window, touch phone, tablet with mouse, and desktop all choose coherent shell/panels |
| Offline/shared data | Correct offline availability and sync states; private reading state and admin restrictions remain intact |
| Service worker | Updated shell is one coherent version, including mobile and desktop assets |

Suggested visual sizes: 393 × 852, 700px boundary, 768px tablet, 900px touch/mouse boundary, 1024px tablet/compact desktop, 1280 × 800, and 1920 × 1080. Test pointer differences explicitly; resizing a desktop browser is not a full substitute for touch/Safari verification. Include 200% zoom and keyboard-only checks.

Use a disposable fixture library with long titles, duplicate-series volumes, nested contents, many chapters, missing artwork, populated annotations, and illustration-only EPUBs. Existing tests have useful reader regressions, but the current desktop test is too narrow to establish consistency of all these screens.

## Automated scan interpretation

The static scan reported **70 signals**: 27 low-contrast, 32 border/shadow advisories, 4 undersized-text, 3 clipped-overflow, 2 layout-transition, 1 cream-palette, and 1 pulsing-dot signal. The scan was repeated once to summarize the initially truncated output.

These are not 70 established product defects. Static analysis mixes theme and breakpoint declarations, and many records point to line 0. It can pair foreground/background values that never coexist on a visible screen. The cream palette and some glass/border/shadow treatments are deliberate parts of the requested aesthetic and should not be removed merely to satisfy a detector. The speech dot can represent real playback; its semantics and reduced-motion behavior matter more than a blanket style ban.

The actionable findings in this report are grounded in observed layouts and verified source contracts. Contrast examples above were calculated independently. No browser detector overlay was injected, no extra visualization server was started, and the temporary inspection tab/viewport override were cleaned up.

## Decision

Recommend a shared visual system with responsive presentations: keep mobile, modernize desktop, and finish the reader tools. A cosmetic desktop recolor alone would leave navigation and behavior inconsistencies. A complete application rewrite would add risk without being necessary for this goal.

The first implementation milestone should combine shared tokens, broken styling/accessibility contracts, and desktop Home/Library navigation. The next milestone should complete the reader panels and audio/annotation flows. This order creates visible desktop improvement while protecting the existing mobile experience.
