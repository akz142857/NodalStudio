# Nodal Studio — English App Store product screenshots

Updated: 2026-10-25. Positioning: database model visualization for applications built in the AI development era.

The `en-US/` directory contains the five final PNGs in upload order. `Nodal-Studio-App-Store-en-US.zip` contains only these five files.

| Order | Headline | Supporting copy | Figma node |
| --- | --- | --- | --- |
| 01 | See the database behind your AI-built app. | Explore tables, columns, and relationships in your application’s database. | 4:2 |
| 02 | Keep up as your schema evolves. | Compare schema snapshots and inspect what changed as your app grows. | 4:11 |
| 03 | Understand what each field means. | Explore field types, constraints, and existing database comments. | 6:2 |
| 04 | Ask questions with schema context. | Turn questions into SQL drafts. Review the SQL before you run it. | 4:20 |
| 05 | Explore your results visually. | Inspect query results as data or supported charts. | 6:11 |

Figma: https://www.figma.com/design/l8i6l0cCSQ9IlufgjzqadK/Nodal-Studio

## Visual and content review

All five final exports were visually inspected at 1440 × 900 on 2026-10-25. Headlines use 96 px and subtitles 42 px on the original 2880 × 1800 canvas. Text fits without clipping or overlap. The existing typography, background, screenshots, crop positions and numbering were preserved in this positioning update.

- 01: complete relationship paths and table cards remain visible. This presents visualization, not automatic schema editing or code synchronization.
- 02: before/after snapshots and added-column summary are visible. The copy accurately describes historical schema comparison, not an unshown review workflow.
- 03: two enlarged crops from the same native inspector are explicitly labelled. Field meaning is grounded in existing comments, types and constraints; the copy does not promise automatic business-semantic inference.
- 04: explanation, SQL draft, assumptions and review action are visible. The footer retains the requirement for the user's own AI provider configuration. No automatic SQL execution is claimed.
- 05: chart axes, categories, Chart/Data control and result metadata remain visible. The footer identifies the selected category; the highlighted value is not presented as the total order count.

Original artboards and archived designs are preserved in Figma. The prior local export set remains in `../app-store-product-page-v1-before-review/`. No application UI or query results were fabricated.

## Export verification

- Five PNGs, each 2880 × 1800, RGB with no alpha channel.
- Original Figma exports retained in `figma-originals/`.
- Source alpha was fully opaque; RGB conversion preserves every RGB pixel.
- Full image decoding, dimensions, checksums and pixel equality recorded in `export-verification.json`.
- ZIP integrity checked; archive contains exactly the five final PNGs.

## Submission boundary

These product-page assets use native acceptance-app screenshots. They do not establish signed Mac App Store build acceptance. Before submission, confirm that the final submitted build presents the pictured capabilities consistently.

No Git commit, App Store upload, submission or publication was performed.
