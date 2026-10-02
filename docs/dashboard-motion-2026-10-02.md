# Dashboard interaction motion — 2 October 2026

This extends the earlier menu and sheet animations. The focal interaction is a sliding paper bookmark behind the active destination in both the desktop sidebar and mobile tab bar. A brief destination fade links that movement to the resulting screen. Content remains immediately usable.

Impeccable's animation guidance shaped the timing, interruption and reduced-motion behavior. Replit provided a read-only inspection of the Marginalia reference: small navigation nudges, cover lift, primary-button elevation and search/control transitions. Plugin discovery confirmed the relevant connected design capabilities. The implementation uses existing CSS and the Web Animations API without new dependencies.

| Interaction | Motion |
| --- | --- |
| Active navigation | Highlight slides over 230 ms; rapid changes continue from its current visual position |
| Destination change | 170 ms opacity transition; same-page filtering and background refreshes do not replay it |
| Book hover | Cover frame lifts 3 px with a soft shadow over 220 ms |
| Primary action hover | Button rises 1 px with a small shadow |
| Secondary controls | Small hover lift and existing color/border feedback |
| Press/touch | Controls compress slightly; book actions use a smaller scale change |
| Navigation and action icons | 1–3 px directional nudge; mobile navigation icons compress on press |
| Ratings | Small hover enlargement and pressed response |
| Dashboard modal | 220 ms entrance with a short translation and scale; full-screen phone panels use a 170 ms fade to keep their edges fixed |
| Inputs and management rows | Border/surface feedback on focus, hover and press |

Hover movement is restricted to fine pointers that support hover. Touch uses pressed states. Reduced-motion preferences remove spatial effects and cancel any running navigation or destination animation immediately. Indicators cannot intercept input. Reader entry hides shell indicators and cancels shell fades.

Uploaded cover images retain their source, proportions, colors, upright presentation and image transforms. Only their dashboard frames move. EPUB page turns, reader content and reading controls retain their existing behavior.

Verification includes keyboard, touch and mouse interactions; rapid navigation interruption; reduced-motion changes during animation; marker alignment; unchanged cover-image transforms and filters; desktop/mobile visual checks in both themes; and the existing reader regression suite. Captures and browser checks use isolated fixture data.

Shell assets and service-worker caches share build `v15.5.0-20261002`.

Verified results: the complete WebKit browser suite passed 61 tests with one existing cold-offline test skipped; all four server tests passed. A Chromium mouse check confirmed the hover lift, navigation alignment and reduced-motion behavior. Cover images retained `transform: none` and `filter: none` during hover. Desktop and phone visual checks confirmed stable full-screen panels after replacing their scale entrance with a fade.
