# Theater redesign QA

## Source of truth

- Reference: `/Users/yewei/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_p9mi47oklk2f21_472c/temp/RWTemp/2026-09/d9dc35c327c7a816f9c4b17ef9434b73/d47ae072366fa063100d357b83b0acbc.jpg`
- Implementation: `/Users/yewei/Documents/Codex/2026-08-31/zhe/outputs/nightflix-theater-light-pass1.png`
- Side-by-side comparison: `/Users/yewei/Documents/Codex/2026-08-31/zhe/outputs/nightflix-theater-light-reference-comparison.png`
- State: Simplified Chinese, Theater tab, default catalog, live tenant data
- Viewports: reference 1280x2774; implementation 1080x2400. Both were normalized to 2048 px height for comparison.

## Iteration findings

1. P1 — The former dark theme, empty header space, and sparse controls did not match the supplied Theater reference. The Theater surface and its selected bottom navigation state now use the same light hierarchy as the reference.
2. P1 — Landscape source videos previously produced padded poster images with black bars. Cover extraction now center-crops every source frame to a filled 720x1280 (9:16) poster.
3. P1 — The page lacked the reference's compact discovery hierarchy. It now has a white search/recognition bar, horizontal discovery tabs, four white quick-action tiles, and a dense two-column poster grid.
4. P2 — The previous cards felt detached and dark. Cards now use white surfaces, rounded poster corners, readable black titles, warm secondary copy, and a compact episode badge over the poster.
5. P2 — The Theater bottom navigation previously remained in the global dark style. It now switches to a white bar with black active state only while Theater is selected; other screens keep the existing Night Flix dark theme.

## Intentional deviations

- Night Flix only exposes short-drama discovery categories. Reference tabs for novels, comics, shopping, and unrelated product areas are not copied.
- The current API does not own a heat metric, so the poster badge truthfully shows episode count instead of fabricated popularity numbers.
- Covers use the tenant's own source videos and Material icons. No reference-app artwork or copyrighted UI assets were copied.

## Functional evidence

- Search and the recognition-side affordance open the existing drama search flow.
- Filter opens a light category sheet; server categories remain selectable.
- Ranking, new-release, favorites, and category tabs alter the visible catalog state.
- Every poster opens the existing player flow.
- Existing non-Theater screens preserve their former dark navigation visual regression goldens.
- Flutter analyzer and the complete widget/unit/golden suite are required release gates.

## Final result

Passed — the side-by-side comparison has no open P0, P1, or P2 mismatch within the short-drama-only scope.
