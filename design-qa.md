# Theater redesign QA

## Source of truth

- Reference: `/Users/yewei/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_p9mi47oklk2f21_472c/temp/RWTemp/2026-09/d9dc35c327c7a816f9c4b17ef9434b73/d47ae072366fa063100d357b83b0acbc.jpg`
- Implementation: `/Users/yewei/Documents/Codex/2026-08-31/zhe/outputs/nightflix-theater-redesign-pass2.png`
- Side-by-side comparison: `/Users/yewei/Documents/Codex/2026-08-31/zhe/outputs/nightflix-theater-reference-comparison.png`
- State: Simplified Chinese, Theater tab, default catalog
- Viewports: reference 1280x2774; implementation 1080x2400. Both were normalized to 2048 px height for comparison.

## Iteration findings

1. P1 — The original large title consumed the first quarter of the screen and delayed the first poster row. Replaced it with a compact search surface and discovery controls.
2. P1 — Search, content/category navigation, and the four discovery shortcuts visible in the reference were missing. Added working search, category/filter, ranking, new-release, and favorite controls.
3. P2 — The first implementation used tall vertical shortcut buttons. Changed them to compact horizontal icon-and-label controls and reduced surrounding padding.
4. P2 — Drama cards lacked quick scanning metadata. Added an episode-count overlay and a one-line secondary label while retaining two-column poster density.
5. P3 — The reference displays heat scores, but the current API has no heat/ranking metric. Episode count is used instead; a real heat metric should only be shown after the backend owns that data.

## Intentional deviations

- Night Flix keeps its existing dark brand rather than copying the reference app's light theme.
- Only short-drama discovery is shown; unrelated books, comics, shopping, and reward content from the reference are outside this product's scope.
- Posters and icons use Night Flix/backend assets and Material icons; no copyrighted reference assets were copied.

## Functional evidence

- Search opens the existing drama search flow and returns catalog results.
- Filter opens a category bottom sheet; available server categories remain selectable.
- Ranking, new-release, and favorite controls alter the visible catalog state.
- Every poster still opens the player flow.
- Flutter analyzer and the complete widget/unit/golden suite are the release gate.

## Final result

Passed — no open P0, P1, or P2 visual/interaction mismatch remains for the scoped Theater redesign.
