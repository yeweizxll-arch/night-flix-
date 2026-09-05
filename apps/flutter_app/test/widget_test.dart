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

  test('demo exposes the target market language set including Chinese', () {
    expect(AppRuntimeConfig.demo.supportedLocales, contains('zh-CN'));
    expect(AppRuntimeConfig.demo.supportedLocales, contains('zh-TW'));
    expect(
      AppRuntimeConfig.demo.supportedLocales.length,
      greaterThanOrEqualTo(15),
    );
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

  testWidgets('following tab filters dramas and follow state persists', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Following').first);
    await tester.pumpAndSettle();
    expect(find.text('No followed dramas yet'), findsOneWidget);

    await tester.tap(find.text('Browse For You'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Follow'));
    await tester.pumpAndSettle();
    expect(controller.following, contains('demo-1'));

    await tester.tap(find.text('Following').first);
    await tester.pumpAndSettle();
    expect(find.text('The Last Contract'), findsOneWidget);

    final restored = AppController(DramaRepository(apiBaseUrl: ''));
    await restored.initialize();
    expect(restored.following, contains('demo-1'));
  });

  testWidgets('simplified Chinese changes navigation and demo content', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Language'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('简体中文'));
    await tester.pumpAndSettle();

    expect(controller.locale, 'zh-CN');
    expect(controller.dramas.first.title, '最后的契约');
    expect(find.text('剧场'), findsOneWidget);
    expect(find.text('我的'), findsOneWidget);
    await tester.tap(find.text('推荐'));
    await tester.pumpAndSettle();
    expect(find.text('最后的契约'), findsOneWidget);
    expect(find.text('追剧'), findsWidgets);
  });

  test('demo episodes provide local playback and unlock state', () async {
    final repository = DramaRepository(apiBaseUrl: '');
    final dramas = await repository.dramas();
    final free = await repository.playback(dramas.first.episodes.first, '');
    expect(free.playbackUrl, startsWith('asset://assets/demo/'));

    final locked = dramas.last.episodes[1];
    expect((await repository.playback(locked, '')).playbackUrl, isNull);
    final challenge = await repository.createRewardedChallenge(locked.id, '');
    expect(challenge.adUnitId, isNotEmpty);
    expect(
      await repository.rewardedStatus(challenge.challengeId!, ''),
      'granted',
    );
    expect((await repository.playback(locked, '')).playbackUrl, isNotNull);
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
    await tester.tap(find.text('Episodes'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('2'));
    await tester.pumpAndSettle();
    expect(find.text('Watch ad · unlock 1 episode'), findsOneWidget);
  });
}
