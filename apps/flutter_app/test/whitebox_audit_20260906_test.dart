// Regressions for defects found by the 2026-09-06 white-box audit.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';

class LocaleFailureRepository extends DramaRepository {
  LocaleFailureRepository() : super(apiBaseUrl: '');
  @override
  Future<List<Drama>> dramas({String locale = 'en-US', String? query}) {
    if (locale == 'es-ES') throw const ApiException('locale is invalid', 400);
    return super.dramas(locale: locale, query: query);
  }
}

class WholeDramaPriceRepository extends DramaRepository {
  WholeDramaPriceRepository() : super(apiBaseUrl: 'https://audit.example.test');
  static const paidDrama = Drama(
    id: 'paid-drama',
    title: 'Paid drama',
    summary: '',
    totalEpisodes: 1,
    pointsAmount: 300,
    episodes: [
      Episode(
        id: 'paid-episode',
        number: 1,
        title: 'Episode 1',
        durationSeconds: 60,
        previewSeconds: 0,
      ),
    ],
  );
  @override
  Future<AppRuntimeConfig> bootstrap() async => AppRuntimeConfig.demo;
  @override
  Future<List<Drama>> dramas({String locale = 'en-US', String? query}) async =>
      [paidDrama];
  @override
  Future<Drama> detail(Drama drama, String locale) async => drama;
  @override
  Future<Episode> playback(Episode episode, String accessToken) async =>
      throw const ApiException('Full playback access is required', 403);
  @override
  Future<DramaInteractionSummary> interactionSummary(
    String dramaId,
    String accessToken,
  ) async => const DramaInteractionSummary(
    commentCount: 0,
    favoriteCount: 0,
    isFavorite: false,
    isLiked: false,
    likeCount: 0,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test(
    'WB-F01: failed language change preserves usable startup locale',
    () async {
      final first = AppController(LocaleFailureRepository());
      await first.initialize();
      await expectLater(first.setLocale('es-ES'), throwsA(isA<ApiException>()));
      expect(
        (await SharedPreferences.getInstance()).getString(':locale'),
        'en-US',
      );
      expect(first.locale, 'en-US');
      final restarted = AppController(LocaleFailureRepository());
      await restarted.initialize();
      expect(restarted.dramas, isNotEmpty);
      expect(restarted.error, isNull);
    },
  );

  test('WB-F02: accounts and guests have separate local state', () async {
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await controller.login('a@example.test', 'password');
    await controller.toggleFavorite('demo-1');
    await controller.toggleFollowing('demo-1');
    await controller.markWatched('demo-1');
    await controller.toggleLike('demo-1');
    await controller.logout();
    await controller.login('b@example.test', 'password');
    expect(controller.session!.email, 'b@example.test');
    expect(controller.favorites, isEmpty);
    expect(controller.following, isEmpty);
    expect(controller.history, isEmpty);
    expect(controller.interactions, isEmpty);
    final restarted = AppController(DramaRepository(apiBaseUrl: ''));
    await restarted.initialize();
    expect(restarted.session, isNull);
    expect(restarted.history, isEmpty);
    await controller.login('a@example.test', 'password');
    expect(controller.favorites, contains('demo-1'));
    expect(controller.following, contains('demo-1'));
    expect(controller.history, contains('demo-1'));
  });

  test('WB-F03: expired access token refreshes once and retries protected requests', () async {
    final paths = <String>[];
    final client = MockClient((request) async {
      paths.add(request.url.path);
      if (request.url.path.endsWith('/auth/login')) {
        return http.Response(
          jsonEncode({
            'accessToken': 'expired-token',
            'refreshToken': 'valid-refresh-token',
          }),
          200,
        );
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        expect(jsonDecode(request.body)['refreshToken'], 'valid-refresh-token');
        return http.Response(
          jsonEncode({
            'accessToken': 'new-token',
            'refreshToken': 'rotated-refresh-token',
            'principal': {'accountId': 'account-a'},
          }),
          200,
        );
      }
      if (request.headers['authorization'] == 'Bearer new-token') {
        return http.Response(
          jsonEncode({
            'access': 'full',
            'url': 'https://media.example.test/episode.mp4',
          }),
          200,
        );
      }
      return http.Response(jsonEncode({'message': 'Session has expired'}), 401);
    });
    await http.runWithClient(() async {
      final repository = DramaRepository(
        apiBaseUrl: 'https://audit.example.test',
      );
      final session = await repository.login('a@example.test', 'password');
      const episode = Episode(
        id: 'episode-1',
        number: 1,
        title: 'Episode',
        durationSeconds: 60,
        previewSeconds: 0,
      );
      for (var i = 0; i < 2; i++) {
        expect(
          (await repository.playback(episode, session.accessToken)).access,
          'full',
        );
      }
    }, () => client);
    expect(paths.where((path) => path.contains('refresh')), hasLength(1));
    expect(paths.where((path) => path.endsWith('/url')), hasLength(3));
  });

  testWidgets('WB-F04: Spanish navigation is translated', (tester) async {
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await controller.setLocale('es-ES');
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    expect(
      Localizations.localeOf(tester.element(find.byType(AppShell)))
          .languageCode,
      'es',
    );
    expect(find.text('Para ti'), findsWidgets);
    expect(find.text('Biblioteca'), findsOneWidget);
    expect(find.text('For You'), findsNothing);
  });

  testWidgets('WB-F05: theater category filters and cards open a player', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Drama'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Romance'));
    await tester.pumpAndSettle();
    final romance = tester.widget<FilterChip>(
      find.widgetWithText(FilterChip, 'Romance'),
    );
    expect(romance.selected, isTrue);
    expect(find.text('Reborn for Revenge'), findsNothing);
    await tester.tap(find.text('The Last Contract'));
    await tester.pumpAndSettle();
    expect(find.text('Drama Theater'), findsNothing);
    expect(find.byType(DramaPage), findsOneWidget);
    expect(find.byType(BackButton), findsOneWidget);
  });

  testWidgets(
    'WB-F06: whole-drama pricing shows unlock and offstage players deactivate',
    (tester) async {
      final controller = AppController(WholeDramaPriceRepository());
      await controller.initialize();
      controller.session = const UserSession(
        accessToken: 'audit',
        refreshToken: 'audit',
        email: 'a@example.test',
      );
      await tester.pumpWidget(DramaApp(controller: controller));
      await tester.pumpAndSettle();
      expect(find.text('Retry playback'), findsNothing);
      expect(find.text('Continue watching'), findsOneWidget);
      expect(find.text('Watch ad · unlock 1 episode'), findsOneWidget);
      expect(find.text('Unlock · 300 Coins'), findsWidgets);
      await tester.tap(find.text('Me'));
      await tester.pumpAndSettle();
      final page = tester.widget<DramaPage>(
        find.byType(DramaPage, skipOffstage: false).first,
      );
      expect(page.active, isFalse);
    },
  );
}
