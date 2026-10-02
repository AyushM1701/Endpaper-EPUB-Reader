# Final release verification — 2 October 2026

Build: `v15.6.3-20261002`. Publication target: `main` in AyushM1701/Endpaper-EPUB-Reader.

The release brings the desktop dashboard, library and account tools into the same visual system as mobile, preserving the phone layout and original uploaded cover images. Shared colors, local fonts/SVG icons, visible ratings, grouped More destinations, accessible menus and reduced-motion support accompany the reader fixes and reusable CFI indexes documented in the earlier reports.

## Final review fixes

- Account transitions close and clear book-details and notebook overlays, including private tags and filters. Detached reading-status controls reject account changes; completion handlers cannot update the next account's UI.
- Rating writes are ordered per book/account. Failed earlier saves cannot undo a newer choice, and pending queues survive ordinary reader teardown. Failure rollback uses the last acknowledged rating.
- Keyboard rating focus returns to the same visible surface, including mobile after closing Collections. Book details and the notebook support Escape, focus containment and return focus.
- Reader controls remain available while a dialog or keyboard control is active. Tests explicitly reveal controls before keyboard use and set the appearance they intend to check.
- Background location generation uses independent EPUB sections. A reproduction that paused chapter serialization confirmed that the former shared-section unload could erase pending render output. The regression now passes with chapter text and its security policy intact.

## Final checks

| Check | Result |
| --- | --- |
| Complete WebKit browser suite | 83 passed, 1 documented skip; 3.6 minutes |
| Complete Chromium browser suite | 84 passed, no skips; 1.9 minutes |
| Server/API and frontend invariant tests | 4 passed |
| JavaScript syntax | All 13 checked source/config/regression files passed |
| Whitespace and publication scope | Passed; no local data, credentials or generated test output included |
| Independent review | Account, rating, focus and indexing findings addressed |

Browser suites run sequentially against a temporary database/server on port 39137. They cover desktop/mobile navigation, dropdown pointer and keyboard behavior, scrolling and page turns, hostile EPUB markup, annotation failures/races, audio timing, page-index equivalence/cache recovery, account isolation, offline downloads and coherent updates. Speech timing uses a controlled substitute; it does not certify device speech output.

The WebKit skip is the existing cold offline reload limitation in the Windows Playwright harness. Chromium exercises that check successfully. Physical iPhone Safari and Home Screen launch, native selection/swipe behavior, safe areas/rotation, real speech output and update activation remain device acceptance checks.

Live library/account/progress data was preserved. Fonts and icon attribution are included, and the HTML asset URLs and service worker share the release version. Earlier dated reports describe their respective implementation stages; this report supplies the final release check results. The separate `server/test/reader-audit` directory retains historical diagnostic reproductions and is outside the release regression suite.

To load the release, refresh Endpaper outside the reader. Installed phone apps can use More → Check for updates and apply an available update after leaving the book.
