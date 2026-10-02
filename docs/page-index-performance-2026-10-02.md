# Page-index performance — 2 October 2026

The reader previously waited for 2.5 seconds without interaction before starting its location index. Scrolling or turning pages postponed that work, and EPUB.js then added a 100 ms timer after every chapter, in addition to its animation-frame queue. Completed indexes survived only in the current tab. Changing reader layouts while generation was running could also discard the completion result.

Generation now starts after the book opens, with a bounded 300 ms idle deadline and no quiet-reading requirement. The extra chapter pause is reduced to 1 ms; EPUB.js still yields between chapters. The original 1024-character location algorithm is unchanged. Completion follows the active book across layout changes and updates the current rendition without navigating away from the saved position.

Completed indexes are stored in IndexedDB, keyed by account, book ID, index format and the SHA-256 fingerprint of the original EPUB. Hashing runs alongside opening the book. Cached entries are validated before use; corrupt or unavailable storage falls back to normal generation. Reads and database operations have bounded deadlines. The cache stores derived CFI strings, not chapter text, credentials, annotations or reading progress. It retains at most 12 entries, with a 2 MB per-entry and 8 MB aggregate string budget, evicting least recently accessed entries. Deleting a book purges its indexes. Asset and worker versions are aligned at `v15.6.0-20261002`.

On the isolated 40-chapter fixture in WebKit, generation took 3,678 ms versus 7,493 ms for the original bundled parser pacing. Opening and displaying the first calculated count took 4,302 ms; reopening after a reload with the persistent index took 476 ms. These are local fixture measurements, not a guarantee for every EPUB or device. The generated CFI arrays were identical to the reference parser.

Chromium passed all five focused tests. The same fixture generated in 681 ms versus 4,367 ms with original pacing; its cached reopen took 136 ms.

Verification: the complete WebKit suite passed 74 tests with one existing cold-offline test skipped. Five focused tests cover generation across layout changes, exact reference-index equivalence, reload reuse and saved-position preservation, unavailable storage, corrupt cache recovery and account isolation. All four server tests passed, JavaScript syntax checks passed, and the whitespace check passed. Test books and accounts use temporary isolated data; the live library was untouched.
