import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';

void main() {
  test('runtime configuration safely falls back to app defaults', () {
    final config = AppRuntimeConfig.fromJson(const {'siteName': 'Agent One'});
    expect(config.siteName, 'Agent One');
    expect(config.defaultLocale, 'en-US');
    expect(config.admobEnabled, isFalse);
    expect(config.inAppPurchasesEnabled, isFalse);
  });

  test('interaction and rewarded unlock responses retain server state', () {
    final summary = DramaInteractionSummary.fromJson(const {
      'commentCount': 8,
      'favoriteCount': 4,
      'isFavorite': true,
      'isLiked': true,
      'likeCount': 12,
    });
    final challenge = RewardedUnlockChallenge.fromJson(const {
      'adUnitId': 'test-rewarded-unit',
      'alreadyUnlocked': false,
      'challengeId': 'challenge-1',
      'status': 'pending',
    });
    expect(summary.commentCount, 8);
    expect(summary.isLiked, isTrue);
    expect(challenge.adUnitId, 'test-rewarded-unit');
    expect(challenge.status, 'pending');
  });

  testWidgets('guest can enter the vertical drama feed', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    expect(find.text('The Last Contract'), findsOneWidget);
    expect(find.text('For You'), findsWidgets);
    expect(find.text('Drama'), findsOneWidget);
    expect(controller.session, isNull);
  });

  testWidgets('profile sign-in opens the account gate', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Continue with email'), findsOneWidget);
    expect(find.text('Continue with Google'), findsNothing);
    expect(find.text('Continue with Apple'), findsNothing);
  });

  testWidgets('locked episodes offer direct one-episode ad unlock', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(PageView), const Offset(0, -700));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(PageView), const Offset(0, -700));
    await tester.pumpAndSettle();
    expect(find.text('Watch ad · unlock 1 episode'), findsOneWidget);
  });
}
