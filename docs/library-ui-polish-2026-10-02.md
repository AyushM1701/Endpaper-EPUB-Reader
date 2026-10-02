# Library and More page polish — 2 October 2026

The screenshots exposed three implementation issues: desktop ratings used `opacity: 0` until hover/focus, sidebar hover and selection shared the same surface color, and the desktop More page reused a divider background as a large list surface. Its content also inherited a centered, narrower container than the page heading.

Ratings are now visible by default, with local Lucide SVG stars, distinct filled and empty states, named controls and pressed states. Rating changes still use the existing API and retain rollback on failure. Rated books also show their saved rating in mobile cards; the mobile detail screen retains its five touch controls. Reserving two title lines gives desktop card metadata a steadier rhythm without changing uploaded covers.

More now groups the existing destinations into Reading, Library, Preferences & help, and Account. Desktop uses two columns aligned with the heading; phone uses the same sections in a single column. The account identity and role are separate from the subdued build footer. SVG icons and trailing chevrons replace text symbols. Admin-only actions remain restricted to administrators, and Reader accounts retain book upload access.

Sidebar hover uses a lighter tint than selection. The active destination retains its moving background, heavier label and a small indicator, with exactly one current navigation item. Existing reduced-motion support remains in place.

The shared icon module is local and precached with build `v15.6.2-20261002`. Lucide attribution is included in `public/icons/LUCIDE-LICENSE.txt`. No icon CDN or product dependency was added.

Verification: eight targeted WebKit checks passed. Chromium checks passed for ratings and persistence, grouped navigation, Reader permissions, icon controls, More destinations, cold offline startup and coherent update versions. All four server tests, JavaScript syntax checks and whitespace checks passed. Desktop and phone renders were inspected, including light and dark themes. Fixtures use temporary isolated data; the live library and reading experience were preserved.
