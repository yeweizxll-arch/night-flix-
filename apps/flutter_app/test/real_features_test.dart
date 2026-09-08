import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/drama_scanner.dart';
import 'package:night_flix/src/models.dart';

const session = UserSession(
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  email: 'features@example.test',
);

class FeatureFixture extends DramaRepository {
  FeatureFixture() : super(apiBaseUrl: '');
  final sorts = <String>[];
  final records = <bool>[];
  final feedbackItems = <Map<String, dynamic>>[];
  int favoriteWrites = 0;
  Completer<void>? favoriteGate;
  @override
  Future<List<Drama>> discover({
    required String locale,
    String sort = 'recommended',
    String? category,
  }) async {
    sorts.add(sort);
    return super.discover(locale: locale, sort: sort, category: category);
  }

  @override
  Future<void> setFavorite(String dramaId, String token, bool favorite) async {
    favoriteWrites++;
    await favoriteGate?.future;
  }

  @override
  Future<Map<String, dynamic>> accountRecords({
    required bool entitlements,
    String? cursor,
    String locale = 'en-US',
    String status = 'active',
  }) async {
    records.add(entitlements);
    return {
      'items': entitlements
          ? [
              {
                'id': 'entitlement',
                'title': 'Purchased series',
                'type': 'drama',
                'status': 'active',
                'expiresAt': null,
              },
            ]
          : [
              {
                'id': 'ledger',
                'deltaPoints': '25',
                'balanceAfterPoints': '25',
                'entryType': 'credit',
                'createdAt': '2026-09-07T00:00:00Z',
              },
            ],
    };
  }

  @override
  Future<List<InboxMessage>> inbox(String accessToken) async => [
    InboxMessage(
      id: 'message',
      title: 'Already read',
      body: 'Full message line one.\nFull message line two.\nFinal complete paragraph.',
      status: 'read',
    ),
  ];
  @override
  Future<Map<String, dynamic>> feedback({
    String? body,
    String locale = 'en-US',
    int page = 1,
    String? requestKey,
  }) async {
    if (body != null) {
      expect(requestKey, isNotEmpty);
      feedbackItems.add({
        'id': 'feedback',
        'body': body,
        'createdAt': '2026-09-07T00:00:00Z',
        'reply': 'Operator response',
      });
      return {'id': 'feedback'};
    }
    return {'items': feedbackItems};
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test(
    'discovery, categories, guest counts and comments call actual scoped APIs',
    () async {
      final calls = <http.Request>[];
      await http.runWithClient(
        () async {
          final repository = DramaRepository(
            apiBaseUrl: 'https://features.example.test',
          );
          expect((await repository.categories('zh-CN'))['action'], '动作');
          final ranked = await repository.discover(
            locale: 'zh-CN',
            sort: 'popular',
            category: 'action',
          );
          expect(ranked.map((d) => d.id), ['high', 'low']);
          expect(ranked.first.heat, 31);
          expect(
            (await repository.interactionSummary('high', '')).likeCount,
            7,
          );
          expect(
            (await repository.comments('high', '', page: 2)).single.status,
            'visible',
          );
          repository.session = session;
          await repository.discover(locale: 'zh-CN', sort: 'recommended');
        },
        () => MockClient((request) async {
          calls.add(request);
          final path = request.url.path;
          if (path.endsWith('/categories')) {
            return http.Response(
              jsonEncode({
                'items': [
                  {'code': 'action', 'name': '动作'},
                ],
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          if (path.endsWith('/summary')) {
            expect(request.headers['authorization'], isNull);
            return http.Response('{"likeCount":7}', 200);
          }
          if (path.endsWith('/comments')) {
            expect(request.headers['authorization'], isNull);
            expect(request.url.queryParameters['page'], '2');
            return http.Response(
              '{"items":[{"id":"comment","status":"visible","body":"Test"}]}',
              200,
            );
          }
          if (request.url.queryParameters['sort'] == 'recommended') {
            expect(request.headers['authorization'], 'Bearer test-access');
          }
          return http.Response(
            '{"total":2,"items":[{"id":"high","title":"High","heat":31,"totalEpisodes":2},{"id":"low","title":"Low","heat":1,"totalEpisodes":99}]}',
            200,
          );
        }),
      );
      expect(calls.first.url.path, '/api/v1/customer/content/categories');
      expect(calls[1].url.queryParameters, containsPair('sort', 'popular'));
      expect(calls[1].url.queryParameters, containsPair('category', 'action'));
    },
  );

  test(
    'following, saved content and inbox paginate and use distinct endpoints',
    () async {
      final requests = <String>[];
      await http.runWithClient(
        () async {
          final repository = DramaRepository(
            apiBaseUrl: 'https://features.example.test',
          )..session = session;
          expect(
            await repository.followedDramas(session.accessToken),
            hasLength(101),
          );
          expect(
            await repository.savedDramas(session.accessToken),
            hasLength(101),
          );
          expect(await repository.inbox(session.accessToken), hasLength(51));
          await repository.setFollowing('drama', true);
          await repository.setFollowing('drama', false);
        },
        () => MockClient((r) async {
          requests.add('${r.method} ${r.url.path}');
          expect(r.headers['authorization'], 'Bearer test-access');
          if (r.method != 'GET') return http.Response('{}', 200);
          final size = r.url.path.endsWith('inbox') ? 50 : 100;
          final first = r.url.queryParameters['page'] == '1';
          return http.Response(
            jsonEncode({
              'total': size + 1,
              'items': List.generate(
                first ? size : 1,
                (i) => {
                  'id': '${first ? i : size}',
                  'dramaId': '${first ? i : size}',
                  'title': 'Notice',
                  'body': 'Full body',
                },
              ),
            }),
            200,
          );
        }),
      );
      expect(
        requests,
        contains('POST /api/v1/customer/playback/following/drama'),
      );
      expect(
        requests,
        contains('DELETE /api/v1/customer/playback/following/drama'),
      );
    },
  );

  test('feedback, notification updates and ledger cursors carry real payload and authentication', () async {
    final calls = <http.Request>[];
    await http.runWithClient(
      () async {
        final repository = DramaRepository(
          apiBaseUrl: 'https://features.example.test',
        )..session = session;
        await repository.feedback(
          body: 'A playback problem',
          locale: 'en-US',
          requestKey: 'same-feedback-key',
        );
        await repository.notificationPreferences(
          update: {'marketingPushEnabled': false},
        );
        await repository.accountRecords(
          entitlements: false,
          cursor: 'next-page',
        );
      },
      () => MockClient((r) async {
        calls.add(r);
        return http.Response('{}', 200);
      }),
    );
    expect(
      calls[0].headers['Idempotency-Key'] ??
          calls[0].headers['idempotency-key'],
      'same-feedback-key',
    );
    expect(jsonDecode(calls[0].body), {
      'body': 'A playback problem',
      'locale': 'en-US',
    });
    expect(calls[1].method, 'PUT');
    expect(jsonDecode(calls[1].body), {'marketingPushEnabled': false});
    expect(calls[2].url.path, '/api/v1/customer/wallet/points/ledger');
    expect(calls[2].url.queryParameters['cursor'], 'next-page');
    expect(
      calls.every((r) => r.headers['authorization'] == 'Bearer test-access'),
      isTrue,
    );
  });

  test('favorite double taps produce one write and update aggregate only after success', () async {
    final repo = FeatureFixture();
    final controller = AppController(repo);
    await controller.initialize();
    await controller.login('features@example.test', 'password');
    await controller.loadInteractions('demo-1');
    repo.favoriteGate = Completer<void>();
    final first = controller.toggleFavorite('demo-1');
    await controller.toggleFavorite('demo-1');
    expect(repo.favoriteWrites, 1);
    expect(controller.favorites, isEmpty);
    repo.favoriteGate!.complete();
    await first;
    expect(controller.favorites, contains('demo-1'));
    expect(controller.interactions['demo-1']!.favoriteCount, 1);
  });

  testWidgets('settings buttons persist playback choices after restart', (
    tester,
  ) async {
    final controller = AppController(FeatureFixture());
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Settings'));
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Autoplay next episode'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show subtitles by default'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButton<double>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('1.5×').last);
    await tester.pumpAndSettle();
    expect(controller.autoAdvance, isFalse);
    expect(controller.subtitlesEnabled, isFalse);
    expect(controller.playbackSpeed, 1.5);
    final restored = AppController(FeatureFixture());
    await restored.initialize();
    expect(restored.autoAdvance, isFalse);
    expect(restored.subtitlesEnabled, isFalse);
    expect(restored.playbackSpeed, 1.5);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ranking and new drama buttons select server sorting modes', (
    tester,
  ) async {
    final repo = FeatureFixture();
    final controller = AppController(repo);
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Drama'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('theater-ranking')));
    await tester.pumpAndSettle();
    expect(repo.sorts.last, 'popular');
    await tester.tap(find.byKey(const ValueKey('theater-new')));
    await tester.pumpAndSettle();
    expect(repo.sorts.last, 'latest');
  });

  testWidgets('already-read inbox item opens complete body', (tester) async {
    final repo = FeatureFixture();
    final controller = AppController(repo);
    await controller.initialize();
    await controller.login('features@example.test', 'password');
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Messages'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Already read'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(
      find.widgetWithText(
        SelectableText,
        'Full message line one.\nFull message line two.\nFinal complete paragraph.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('wallet and membership open real account record pages', (
    tester,
  ) async {
    final repo = FeatureFixture();
    final controller = AppController(repo);
    await controller.initialize();
    await controller.login('features@example.test', 'password');
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Coins'));
    await tester.pumpAndSettle();
    expect(repo.records.last, isFalse);
    expect(find.text('25 Coins'), findsOneWidget);
    await tester.tap(find.text('25 Coins'));
    await tester.pumpAndSettle();
    expect(find.textContaining('deltaPoints:'), findsNothing);
    expect(find.textContaining('Record ID:'), findsOneWidget);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Membership'));
    await tester.pumpAndSettle();
    expect(repo.records.last, isTrue);
    expect(find.text('Purchased series'), findsOneWidget);
    expect(find.textContaining('No expiry'), findsOneWidget);
  });

  testWidgets('support sends and displays real repository reply', (
    tester,
  ) async {
    final repo = FeatureFixture();
    final controller = AppController(repo);
    await controller.initialize();
    await controller.login('features@example.test', 'password');
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byIcon(Icons.help_outline), 200);
    await tester.drag(
      find.descendant(
        of: find.byType(ProfileScreen),
        matching: find.byType(ListView),
      ),
      const Offset(0, -180),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.help_outline));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Contact support / My feedback'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Playback needs help');
    await tester.tap(find.text('Send'));
    await tester.pumpAndSettle();
    expect(repo.feedbackItems.single['body'], 'Playback needs help');
    expect(find.text('Operator response'), findsOneWidget);
  });

  testWidgets(
    'Chinese scanner search action uses the existing translated label',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          locale: Locale('zh', 'CN'),
          supportedLocales: [Locale('zh', 'CN')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: DramaScanner(locale: 'zh-CN'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, '搜索短剧'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Search'), findsNothing);
    },
  );

  testWidgets(
    'screenshot recognition suggests searchable text and surfaces permission errors',
    (tester) async {
      const picker = MethodChannel('plugins.flutter.io/image_picker');
      const recognition = MethodChannel('nightflix/text-recognition');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        picker,
        (_) async => '/tmp/test-screenshot.jpg',
      );
      messenger.setMockMethodCallHandler(recognition, (call) async {
        expect(call.arguments['path'], '/tmp/test-screenshot.jpg');
        return ['The Last Contract', 'The Last Contract'];
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(picker, null);
        messenger.setMockMethodCallHandler(recognition, null);
      });
      await tester.pumpWidget(
        const MaterialApp(home: DramaScanner(locale: 'en-US')),
      );
      await tester.tap(find.text('Choose screenshot'));
      await tester.pumpAndSettle();
      expect(find.text('The Last Contract'), findsOneWidget);
      await tester.tap(find.text('The Last Contract'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'The Last Contract',
      );
      messenger.setMockMethodCallHandler(
        picker,
        (_) async => throw PlatformException(code: 'denied'),
      );
      await tester.tap(find.text('Camera'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Unable to read image'), findsOneWidget);
    },
  );
}
