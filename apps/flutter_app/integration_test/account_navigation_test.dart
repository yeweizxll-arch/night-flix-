// Real local Nest/PostgreSQL; no store purchase or external delivery.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';

import 'settings_full_test.dart' as helpers;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'funded wallet shows readable ledger details instead of API fields',
    (tester) async {
      final controller = AppController(
        DramaRepository(apiBaseUrl: helpers.base),
      );
      await controller.initialize();
      await controller.setLocale('en-US');
      await controller.login('records@example.test', helpers.initialPassword);
      await tester.pumpWidget(
        RepaintBoundary(
          key: helpers.captureKey,
          child: DramaApp(controller: controller),
        ),
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      });
      await helpers.ready(tester);
      await helpers.tap(tester, 'Me');
      await helpers.tap(tester, 'Coins');
      expect(find.text('250'), findsOneWidget);
      await helpers.tap(tester, '250 Coins');
      expect(find.textContaining('Balance adjustment'), findsWidgets);
      expect(find.textContaining('deltaPoints:'), findsNothing);
      expect(find.textContaining('referenceType:'), findsNothing);
      expect(find.textContaining('Record ID:'), findsOneWidget);
      await helpers.capture(tester, 'readable-wallet-details');
      await helpers.tap(tester, 'Close');
      await tester.pageBack();
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'signed-in wallet, membership states, disabled store, inbox persisted read and refresh',
    (tester) async {
      final controller = AppController(
        DramaRepository(apiBaseUrl: helpers.base),
      );
      await controller.initialize();
      if (controller.session != null) await controller.logout();
      await controller.setLocale('en-US');
      await controller.login('viewer@example.test', helpers.initialPassword);
      expect(controller.session, isNotNull);
      await tester.pumpWidget(DramaApp(controller: controller));
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      });
      await helpers.ready(tester);
      await helpers.tap(tester, 'Me');
      await helpers.tap(tester, 'Coins');
      expect(find.text('0'), findsOneWidget);
      expect(find.text('Nothing here yet'), findsOneWidget);
      await helpers.tap(tester, 'Get more coins');
      expect(
        find.text('Store unavailable. Please try again later.'),
        findsOneWidget,
      );
      await tester.pageBack();
      await helpers.ready(tester);
      await helpers.tap(tester, 'Membership');
      for (final label in ['Expired', 'Active']) {
        await helpers.tap(tester, label);
        expect(
          tester
              .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, label))
              .selected,
          isTrue,
        );
        expect(find.text('Nothing here yet'), findsOneWidget);
      }
      await helpers.tap(tester, 'Plans and benefits');
      expect(
        find.text('Store unavailable. Please try again later.'),
        findsOneWidget,
      );
      await tester.pageBack();
      await helpers.ready(tester);
      await helpers.tap(tester, 'Messages');
      await helpers.tap(tester, 'Local QA message');
      expect(
        find.widgetWithText(
          SelectableText,
          'Complete local message body. Second sentence stays visible.',
        ),
        findsOneWidget,
      );
      await helpers.tap(tester, 'Close');
      final state = await helpers.qa('state');
      expect((state['messages'] as List).single, containsPair('read', true));
      await helpers.tap(tester, 'Local QA message');
      expect(
        find.widgetWithText(
          SelectableText,
          'Complete local message body. Second sentence stays visible.',
        ),
        findsOneWidget,
      );
      await helpers.tap(tester, 'Close');
      await tester.binding.handlePopRoute();
      await helpers.ready(tester);
      await helpers.tap(tester, 'Rewards');
      await helpers.tap(tester, 'Coin balance');
      expect(find.text('0'), findsOneWidget);
      await tester.pageBack();
      await helpers.ready(tester);
      await helpers.tap(tester, 'Library');
      await helpers.tap(tester, 'Favorites');
      expect(find.text('Nothing here yet').hitTestable(), findsOneWidget);
      await tester.tap(
        find
            .descendant(
              of: find.byType(LibraryScreen),
              matching: find.byType(Tab),
            )
            .first,
      );
      await helpers.ready(tester);
      await tester.drag(
        find.byType(RefreshIndicator).hitTestable().first,
        const Offset(0, 350),
      );
      await helpers.ready(tester);
      expect(tester.takeException(), isNull);
    },
  );
}
