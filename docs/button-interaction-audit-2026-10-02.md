# Menu and button interaction audit — 2 October 2026

The Account dropdown closed before its actions received a pointer click. A `focusout` listener checked `document.activeElement` in a microtask; browsers can temporarily move focus to the body between a pointer press and the final click. Closing the details element removed the pressed item, so the click landed on the library behind it. Event tracing reproduced that sequence, and regression tests failed for appearance, shortcuts and permissions before the fix.

The same dismissal logic also broke Library tools and the reader More menu when a user opened or navigated the menu with the keyboard, then clicked another item. The shared rule now dismisses on an actual outside `focusin`, retaining outside-pointer, Escape and scroll dismissal. It does not suppress touch presses or scrolling.

Menu actions also returned dialog focus to a menu item that had become hidden. Actions now focus the visible menu trigger before opening their destination, so dialogs and drawers restore focus to that trigger on closing.

An additional regression check caught the reader More menu reopening behind Audio options after the focus fix: its action toggled the menu after the dialog's focus had already dismissed it. Reader menu actions now close explicitly through an idempotent helper, including search, notebook, read aloud, audio options, fullscreen and help.

| Surface | Actions checked |
| --- | --- |
| Account | Appearance toggle, shortcuts, people and permissions, logout, keyboard activation, Escape, outside dismissal, focus restoration |
| Library tools | Manage collections, import file picker, backup download, mixed keyboard/mouse input |
| Desktop More | Downloads, notebook, stats, goals, appearance defaults, help, collections, permissions |
| Library and book actions | Upload file picker, sort/filter selection, mobile book-details and metadata-editor sheets |
| Reader menus | Desktop audio, search, notebook and help after keyboard opening; menu dismissal and focus restoration; phone taps for contents, search, settings, bookmarks/highlights and audio options |
| Shared controls | Dynamic options, disabled options, pointer/touch selection, long-list scrolling, reduced motion, viewport fit |

Tests use isolated EPUB fixtures and accounts. The desktop and phone reading layout, original uploaded covers, motion design and source/API behavior are preserved. Shell and service-worker assets share build `v15.5.2-20261002` so installed clients can load the correction together.

Verified: the complete WebKit suite passed 69 tests with one existing cold-offline test skipped. Chromium passed all 17 interaction tests; the final reader-menu and asset-update checks also passed in Chromium after the release version changed. All four server tests passed, JavaScript syntax checks passed, and `git diff --check` reported no whitespace errors. No live library data was used or changed.
