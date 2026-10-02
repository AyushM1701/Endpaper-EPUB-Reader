# Endpaper UI implementation

Approved direction: preserve the Apple Books-like mobile shell and reading controls; use its warm palette, cover-led browsing and action hierarchy on desktop. Source: `docs/ui-analysis-2026-10-02.md`.

1. Publish the shared light/dark semantic colors, spacing and panel geometry in Figma and CSS. Keep EPUB typography preferences independent.
2. Separate desktop Home and Library. Home focuses on returning to reading and cover-led shelves; Library puts search/filter/sort above the catalogue. Share reading-status and series destinations with mobile. Preserve role-aware library management.
3. Unify Contents, in-book Search and Marks panel geometry, scroll regions and selection states. Use keyboard-accessible destination controls and contrast-safe colors.
4. Give annotations shared rows with quote, note, location, tags and actions. Replace metadata, note and tag prompts with labeled in-app editors; make Notebook open the chosen passage.
5. Hide inactive speech controls semantically; expose voice/pitch/sleep options on both sizes without enlarging the compact player.
6. Verify meaningful flows in the isolated EPUB fixture environment and inspect desktop/mobile together. Maintain service-worker asset-version coherence. Run the Impeccable detector once on final changed UI files.

Validation: backend unit tests; existing mobile reader tests; desktop Home/Library, series and detail activation; narrow fine-pointer panels; keyboard result/annotation navigation; editor cancellation/save; inactive audio accessibility. Preserve local books, credentials and reader engine behavior.
