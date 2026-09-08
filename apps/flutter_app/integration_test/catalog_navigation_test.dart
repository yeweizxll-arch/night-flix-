// Android UI against the deployed test catalog, guest only. No purchase,
// message, comment or account mutation is submitted to the remote service.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:video_player/video_player.dart';

Future<void> waitFor(WidgetTester tester, bool Function() condition) async {
  for (var i = 0; i < 300; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (condition()) return;
  }
  fail('Expected UI state did not appear within 30 seconds');
}

Future<void> tap(WidgetTester tester, Finder finder) async {
  if (finder.hitTestable().evaluate().isEmpty) {
    await tester.ensureVisible(finder);
  }
  await tester.pump(const Duration(milliseconds: 400));
  await tester.tap(finder);
  await tester.pump(const Duration(milliseconds: 600));
}

Future<void> loginGate(WidgetTester tester, Finder target) async {
  await tap(tester, target);
  await waitFor(
    tester,
    () => find.text('Continue with email').evaluate().isNotEmpty,
  );
  await tap(tester, find.byTooltip('Close'));
  await waitFor(
    tester,
    () => find.text('Continue with email').evaluate().isEmpty,
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'remote guest catalog, search, filters, playback and all primary navigation',
    (tester) async {
      final controller = AppController(
        DramaRepository(apiBaseUrl: 'https://47.110.245.29'),
      );
      await controller.initialize();
      expect(controller.error, isNull);
      expect(controller.session, isNull);
      expect(controller.dramas, isNotEmpty);
      await controller.setLocale('en-US');
      await controller.setPlaybackSettings(autoAdvance: false);
      await tester.pumpWidget(DramaApp(controller: controller));
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      });
      await waitFor(
        tester,
        () => find.byType(VideoPlayer).evaluate().isNotEmpty,
      );
      VideoPlayerController player() =>
          tester.widget<VideoPlayer>(find.byType(VideoPlayer).first).controller;
      bool hasPlayer() => find.byType(VideoPlayer).evaluate().isNotEmpty;
      await waitFor(
        tester,
        () =>
            hasPlayer() &&
            player().value.isInitialized &&
            player().value.isPlaying,
      );
      expect(player().value.hasError, isFalse);
      await tap(tester, find.byKey(const Key('playback-toggle')));
      await waitFor(
        tester,
        () =>
            hasPlayer() &&
            !player().value.isPlaying &&
            find.byKey(const Key('paused-play-button')).evaluate().isNotEmpty,
      );
      await tap(tester, find.byKey(const Key('paused-play-button')));
      await waitFor(tester, () => hasPlayer() && player().value.isPlaying);
      await tap(tester, find.widgetWithText(TextButton, 'Episodes'));
      await waitFor(
        tester,
        () =>
            find.byKey(const ValueKey('episode-cell-10')).evaluate().isNotEmpty,
      );
      await tap(tester, find.byKey(const ValueKey('episode-cell-10')));
      await waitFor(
        tester,
        () => find.textContaining('EP 10').evaluate().isNotEmpty,
      );
      debugPrint('CHECK remote signed video, pause/resume, episode 10');
      await loginGate(tester, find.byIcon(Icons.favorite_border).first);
      await loginGate(tester, find.byIcon(Icons.bookmark_border).first);
      await loginGate(tester, find.widgetWithText(TextButton, 'Follow').first);
      await tap(tester, find.byIcon(Icons.chat_bubble_outline).first);
      await waitFor(
        tester,
        () => find.byType(BottomSheet).evaluate().isNotEmpty,
      );
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(milliseconds: 500));
      debugPrint('CHECK guest like/save/follow gates and comment sheet');
      await tap(tester, find.text('Following').first);
      await waitFor(
        tester,
        () => find.text('Browse For You').evaluate().isNotEmpty,
      );
      await tap(tester, find.text('Browse For You'));
      debugPrint('CHECK following empty-state return');
      await tap(tester, find.text('Drama').last);
      await waitFor(
        tester,
        () =>
            find.byKey(const ValueKey('theater-filter')).evaluate().isNotEmpty,
      );
      for (final key in [
        'theater-ranking',
        'theater-new',
        'theater-category-trending',
      ]) {
        await tap(tester, find.byKey(ValueKey(key)));
        await waitFor(
          tester,
          () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
        );
        expect(find.text('Retry'), findsNothing);
        debugPrint('CHECK $key');
      }
      final categories = await controller.repository.categories('en-US');
      expect(categories.length, greaterThanOrEqualTo(2));
      for (final category in categories.entries.take(2)) {
        final expected = await controller.repository.discover(
          locale: 'en-US',
          sort: 'popular',
          category: category.key,
        );
        expect(expected, isNotEmpty);
        expect(expected.length, lessThan(controller.dramas.length));
        await tap(tester, find.byKey(const ValueKey('theater-filter')));
        await waitFor(
          tester,
          () => find
              .widgetWithText(ListTile, category.value)
              .evaluate()
              .isNotEmpty,
        );
        await tap(tester, find.widgetWithText(ListTile, category.value));
        await waitFor(
          tester,
          () =>
              find.byType(BottomSheet).evaluate().isEmpty &&
              find.byType(LinearProgressIndicator).evaluate().isEmpty,
        );
        expect(
          tester
              .widget<SliverGrid>(find.byType(SliverGrid).first)
              .delegate
              .estimatedChildCount,
          expected.length,
        );
        expect(find.text(expected.first.title), findsOneWidget);
      }
      await tap(
        tester,
        find.byKey(const ValueKey('theater-category-trending')),
      );
      await waitFor(
        tester,
        () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
      );
      expect(
        tester
            .widget<SliverGrid>(find.byType(SliverGrid).first)
            .delegate
            .estimatedChildCount,
        controller.dramas.length,
      );
      await loginGate(tester, find.byKey(const ValueKey('theater-favorites')));
      await tap(tester, find.text('Search dramas').first);
      await waitFor(tester, () => find.byType(TextField).evaluate().isNotEmpty);
      await tester.enterText(find.byType(TextField), 'zz_nonexistent_20260908');
      await waitFor(
        tester,
        () =>
            find.text('No dramas yet').evaluate().isNotEmpty ||
            find.text('Nothing here yet').evaluate().isNotEmpty,
      );
      await tap(tester, find.byIcon(Icons.clear));
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller?.text,
        '',
      );
      await tap(tester, find.byIcon(Icons.arrow_back));
      await tap(tester, find.byKey(const ValueKey('theater-scan')));
      await waitFor(
        tester,
        () => find.text('Find title from screenshot').evaluate().isNotEmpty,
      );
      await tester.pageBack();
      await tester.pump(const Duration(milliseconds: 500));
      debugPrint(
        'CHECK filters, favorite guest gate, empty search, clear, scan route/back',
      );
      await tap(tester, find.text('Rewards').last);
      await loginGate(tester, find.text('Sign in to view'));
      await loginGate(tester, find.text('Get more coins'));
      await tap(tester, find.text('Rewarded episode unlocks'));
      await waitFor(
        tester,
        () => find.byType(BottomSheet).evaluate().isNotEmpty,
      );
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(milliseconds: 500));
      await tap(tester, find.text('Library').last);
      await tap(tester, find.text('Favorites').last);
      await tap(
        tester,
        find
            .descendant(
              of: find.byType(LibraryScreen),
              matching: find.byType(Tab),
            )
            .first,
      );
      await tap(tester, find.text('Me').last);
      for (final label in ['Sign in', 'Membership', 'Coins', 'Messages']) {
        await loginGate(tester, find.text(label).last);
      }
      await tap(tester, find.text('Language'));
      await waitFor(tester, () => find.text('简体中文').evaluate().isNotEmpty);
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(milliseconds: 500));
      expect(tester.takeException(), isNull);
      debugPrint(
        'CHECK rewards, library tabs, profile guest gates, language close',
      );
    },
  );
}
