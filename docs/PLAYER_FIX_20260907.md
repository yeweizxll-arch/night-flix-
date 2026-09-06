# Android player and catalog fixes — 2026-09-07

## Scope and reference

Independent Night Flix client; no Shanchuang service, database, tenant publication, pricing or entitlement mutations.
The supplied Hongguo decompilation is a behavioral reference only. No Java/smali code, icons, fonts or proprietary graphics were copied.

Reference evidence in the supplied `hongguo-analysis.dW2IFz` extraction:

- `res/values/colors.xml` distinguishes catalog selected, normal, disabled and played states (`skin_color_catalog_*`, lines 3429–3438).
- `com/dragon/read/component/shortvideo/impl/catalogview/g.java` changes selected text and indicator visibility independently (around lines 545–585).
- `LandscapePauseCenterV733.java` and `FixLandscapeVideoCutOptV731.java` expose separate landscape-pause and landscape-crop policies. These are configuration flags, not proof of one universal live layout.

## Implemented

- Feed, category and search requests follow every catalog page with deduplication and repeated-page protection. Existing complete-list consumers no longer silently stop at 50 items. Live diagnostic data contained 102 dramas, with all 50 items on page 1 landscape and all 50 items on page 2 portrait.
- Decoded video dimensions determine aspect ratio. Black letterboxing replaces cover-style cropping for both portrait and landscape videos.
- Neutral episode cells; only the selected episode has an accent border/background and playing indicator. Actual episode numbers, single-line scaled text, responsive grid, ascending/descending order and initial positioning near the selected episode. Prices alone no longer falsely claim an episode is locked.
- Noninteractive overlays do not block playback taps. A central play icon identifies pause; bottom transport controls expose play/pause, elapsed/total time and seek-on-release. Preview seeking remains disabled.
- Manual pause survives lifecycle/route reactivation; explicit selection starts the chosen episode. Playback-token refresh is rescheduled on resume. Speed changes apply to video and dubbing together.
- Compact white interaction icons, bounded title/summary, constrained navigation labels, bottom navigation outside the video layout, safe-area-aware bottom controls; playback labels translated in all 15 locales.
- Detail failures display a retry action instead of silently showing a nonfunctional page.

## Verification

`flutter analyze --no-pub`, `flutter test --no-pub`, `git diff --check`.

New tests cover 102-item pagination for all three catalog consumers, repeated-page termination, 16:9 geometry, 320-pixel episode cells including 10/100, selected styling, tap-through overlays, pause/resume, lifecycle pause preservation and seek without resuming paused video. Golden images cover feed, paused player and episode picker; widget-test fonts are geometry fixtures, not a claim of device typography fidelity.

## Boundaries

- This is a targeted repair, not a claim that every Hongguo player feature or every undocumented bug is reproduced/fixed. Automatic landscape rotation/fullscreen mode and a frame-by-frame reference-App visual comparison are not included.
- Catalog consumers currently need the complete list; very large catalogs should migrate to incremental UI pagination rather than fetching all pages at startup.
- Native APK/device verification is recorded separately after building the committed source. No server deployment is implied by local tests.

## Native test artifact

- Built from clean source commit `a1a3ce5`, Flutter 3.47.2, `--debug --dart-define=API_BASE_URL=https://47.110.245.29 --build-number=2026090701`.
- APK: `outputs/nightflix-test-20260907-a1a3ce5.apk` in the outer workspace, SHA256 `ef05ede3722af585633db68b699afb146ca1f843eb9232de28aa3220a0b6d628`.
- All 35 Flutter tests and static analysis passed. Installed using `adb install -r` into the existing Android 15/API 35 emulator without clearing its data; version code verified as 2026090701.
- Real server access log records Dart-client catalog requests for pages 1, 2 and 3, all HTTP 200 (01:53:47–01:53:50 Asia/Shanghai).
- Observed real landscape playback with letterboxing, automatic next episode, current-episode grid marker and unwrapped 10–24 labels. Selected episode 10, paused it, and captured the central play icon and bottom transport in the paused state.
- Search results display both landscape and portrait titles. No backend code/configuration or publication state was changed; no APK download URL was replaced on the server.
- Device screenshots are saved outside Git under outer-workspace `outputs/player-20260907-*.png`.
