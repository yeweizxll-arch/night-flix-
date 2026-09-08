import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';

import 'catalog_navigation_test.dart' as ui;
import 'settings_full_test.dart' as local;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real API categories change results and comments persist with dates',
    (tester) async {
      final controller = AppController(DramaRepository(apiBaseUrl: local.base));
      await controller.initialize();
      await controller.setLocale('en-US');
      await controller.login('viewer@example.test', local.initialPassword);
      await controller.refreshLibrary();
      for (final id in controller.following.toList()) {
        await controller.toggleFollowing(id);
      }
      await tester.pumpWidget(
        RepaintBoundary(
          key: local.captureKey,
          child: DramaApp(controller: controller),
        ),
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      });
      await ui.tap(tester, find.text('Drama').last);
      await ui.waitFor(
        tester,
        () => find.text('QA Romance Series').evaluate().isNotEmpty,
      );
      expect(find.text('QA Fantasy Series'), findsOneWidget);
      for (final genre in ['Romance', 'Fantasy']) {
        await ui.tap(tester, find.byKey(const ValueKey('theater-filter')));
        await ui.tap(tester, find.widgetWithText(ListTile, 'QA $genre'));
        await ui.waitFor(
          tester,
          () =>
              find.byType(BottomSheet).evaluate().isEmpty &&
              find.byType(LinearProgressIndicator).evaluate().isEmpty,
        );
        expect(find.text('QA $genre Series'), findsOneWidget);
        expect(
          find.text('QA ${genre == 'Romance' ? 'Fantasy' : 'Romance'} Series'),
          findsNothing,
        );
      }
      await ui.tap(
        tester,
        find.byKey(const ValueKey('theater-category-trending')),
      );
      await ui.waitFor(
        tester,
        () => find.text('QA Romance Series').evaluate().isNotEmpty,
      );
      expect(find.text('QA Fantasy Series'), findsOneWidget);
      await ui.tap(tester, find.text('QA Romance Series'));
      await ui.waitFor(
        tester,
        () => find.byIcon(Icons.chat_bubble_outline).evaluate().isNotEmpty,
      );
      final drama = controller.dramas.firstWhere(
        (d) => d.title == 'QA Romance Series',
      );
      await ui.tap(tester, find.byIcon(Icons.favorite_border).first);
      await ui.waitFor(
        tester,
        () => find.byIcon(Icons.favorite).evaluate().isNotEmpty,
      );
      expect((await controller.loadInteractions(drama.id)).isLiked, isTrue);
      await ui.tap(tester, find.byIcon(Icons.favorite).first);
      await ui.waitFor(
        tester,
        () => find.byIcon(Icons.favorite_border).evaluate().isNotEmpty,
      );
      expect((await controller.loadInteractions(drama.id)).isLiked, isFalse);
      await ui.tap(tester, find.byIcon(Icons.bookmark_border).first);
      await ui.waitFor(tester, () => controller.favorites.contains(drama.id));
      await controller.refreshLibrary();
      expect(controller.favorites, contains(drama.id));
      await ui.tap(tester, find.byIcon(Icons.bookmark).first);
      await ui.waitFor(tester, () => !controller.favorites.contains(drama.id));
      await ui.tap(tester, find.widgetWithText(TextButton, 'Follow'));
      await ui.waitFor(tester, () => controller.following.contains(drama.id));
      await controller.refreshLibrary();
      expect(controller.following, contains(drama.id));
      await ui.tap(tester, find.widgetWithText(TextButton, 'Followed'));
      await ui.waitFor(tester, () => !controller.following.contains(drama.id));
      await ui.tap(tester, find.byIcon(Icons.chat_bubble_outline).first);
      await ui.waitFor(
        tester,
        () => find.byType(TextField).evaluate().isNotEmpty,
      );
      expect(
        tester
            .widget<IconButton>(find.widgetWithIcon(IconButton, Icons.send))
            .onPressed,
        isNull,
      );
      await tester.enterText(find.byType(TextField), 'Local emulator comment');
      await ui.tap(tester, find.byIcon(Icons.send));
      await ui.waitFor(
        tester,
        () => find.text('Local emulator comment').evaluate().isNotEmpty,
      );
      final comments = await controller.comments(drama.id);
      expect(comments.single.body, 'Local emulator comment');
      final context = tester.element(find.text('Local emulator comment'));
      final stamp =
          '${MaterialLocalizations.of(context).formatMediumDate(comments.single.createdAt.toLocal())} ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(comments.single.createdAt.toLocal()))}';
      expect(find.text(stamp), findsOneWidget);
      await local.capture(tester, 'comments-with-timestamp');
      await ui.tap(tester, find.byType(PopupMenuButton<String>).first);
      await ui.tap(tester, find.text('Report').last);
      await ui.tap(tester, find.text('Confirm').last);
      await ui.waitFor(
        tester,
        () => find.byType(AlertDialog).evaluate().isEmpty,
      );
      final state = await local.qa('state');
      expect(state['reports'] as List, hasLength(1));
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(seconds: 1));
      await ui.tap(tester, find.byIcon(Icons.chat_bubble_outline).first);
      await ui.waitFor(
        tester,
        () => find.text('Local emulator comment').evaluate().isNotEmpty,
      );
      await ui.tap(tester, find.byType(PopupMenuButton<String>).first);
      await ui.tap(tester, find.text('Delete').last);
      await ui.tap(tester, find.text('Confirm').last);
      await ui.waitFor(
        tester,
        () => find.text('Local emulator comment').evaluate().isEmpty,
      );
      expect(await controller.comments(drama.id), isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
}
