# Marginalia dashboard adaptation — 2 October 2026

Reference: the user's Replit app [Desktop Bookstore](https://replit.com/@ayush2006mishra/Desktop-Bookstore), app ID `23558a68-9692-430a-b9db-4abbf7a6eee3`. The private development URL requires login in the browser. Replit's read-only Agent inspected the implemented design system and desktop mockup and supplied the palette, typography, sidebar, book-tile, and hero details. The initial URL/name search missed the app; listing the connected account located it. The Replit project was not modified or published.

## Adaptation

- Desktop library surfaces use the reference's cream/sage palette and matching dark surfaces: background `#f7f7f2` / `#171d19`, sidebar `#eeefe8` / `#202722`, text `#283431` / `#e4e9e1`, muted text `#626f67` / `#a5b0a5`, and hero `#e8eee7` / `#293731`.
- Instrument Serif handles dashboard headings/book titles, DM Sans handles interface text, and DM Mono handles compact reading progress. Fonts and their OFL licenses are self-hosted. The font assets are included in the offline shell cache.
- A 246px full-height sidebar (205px at narrower desktop widths), 72px header, and quieter cover shelves carry the reference's proportions. Existing Home, Library, Search, Notebook, Downloads, account, and upload actions remain functional.
- The primary continue-reading panel puts the real book title, author, available description, saved progress, and reading action beside the original cover. It uses existing book data, without invented chapter labels or descriptions. The whole panel remains keyboard-accessible.
- Book cover sources and server extraction/storage are unchanged. Dashboard images use their existing cover endpoint with no filters or rotation and `object-fit: contain`, preserving the complete uploaded image. The reference's illustrated jackets and tilted cover treatment were deliberately omitted to honor the user's constraint.
- The reference's small author text was increased to 13px for readability. The existing phone navigation remains intact rather than adopting the reference's phone icon rail.

Dashboard tokens are scoped to desktop `body:not(.reader-active)`. The reader's typography, themes, gestures, layout, and audio behavior were not modified for this adaptation. Mobile styling remains on its existing tokens. The additional shared continuation markup is hidden outside the desktop dashboard.

HTML and service-worker assets share `v15.3.0-20261002`.

## Verification

| Check | Result |
| --- | --- |
| Full WebKit browser suite after the adaptation | 52 passed, 1 existing cold-offline restart skip |
| Desktop/UI suite after final heading/fallback-title corrections | 6 passed |
| Server suite | 4 passed |
| JavaScript syntax and whitespace checks | Passed |
| Original-cover check | Home and Library retained the same cover URL; natural proportions preserved, no filter, contain sizing |

Visual inspection covered light/dark desktop Home, Library, a narrower desktop, and mobile Home in two bounded rounds. Captures use temporary test accounts, an EPUB fixture, and illustrative in-memory shelf entries. The cover fixture embeds an existing square PNG to exercise uncropped presentation. No live account/library/progress data was modified.

Logs and captures are in `C:/Users/AYUSH/Documents/EndpaperRecovery` under the `marginalia-` prefix. Refresh Endpaper to load the new dashboard; apply any waiting app update outside the reader.
