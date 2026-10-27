# Nodal Studio — English App Store product screenshots

Completed: 2026-10-25. Five PNGs are in `en-US/`, ordered for upload. The ZIP contains only those five PNGs.

| Order | Theme | Figma node |
| --- | --- | --- |
| 01 | Understand your database at a glance | 4:2 |
| 02 | See what changed. Know what to review. | 4:11 |
| 03 | Give every field context | 6:2 |
| 04 | Turn questions into SQL drafts | 4:20 |
| 05 | See the story in your query results | 6:11 |

Figma: https://www.figma.com/design/l8i6l0cCSQ9IlufgjzqadK/Nodal-Studio

The new 03 and 05 artboards retain the existing English typography, background, screenshot container, footer and numbering. Existing artboards were preserved. Artboard 03 uses the previously captured native table inspector (`target/product-page-screenshots/02-table-inspector.png`). Artboard 05 reuses the real query-chart image from original Figma node 2:17, as requested. No application UI or query results were fabricated.

## Export verification

- Five PNG files, each 2880 × 1800, RGB with no alpha channel.
- Original Figma exports are retained in `figma-originals/`.
- All original alpha values were 255. Removing the redundant channel did not change any RGB pixel; verified pixel-for-pixel.
- Complete image decoding, dimensions and checksums are recorded in `export-verification.json`.
- New designs were visually inspected after composition. Original 01, 02 and 04 designs retain their previous reviewed layouts.
- Apple lists 2880 × 1800 among accepted Mac screenshot dimensions: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications

## Scope

These are product-page assets made from native acceptance-app screenshots. They do not establish signed Mac App Store build acceptance. Frame 02 shows a real historical schema comparison, and frame 03 shows a historical table inspector. Before actual submission, confirm that the submitted build presents these capabilities consistently.

No Git commit, App Store upload, submission or publication was performed.
