import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';
import 'package:night_flix/src/tenant_ads.dart';

const user = UserSession(
  accessToken: 'token-a',
  refreshToken: 'refresh-a',
  email: 'a@example.test',
  accountId: 'account-a',
  deviceId: 'current-device',
);

class SettingsFixture extends DramaRepository {
  SettingsFixture() : super(apiBaseUrl: '');
  Completer<Map<String, dynamic>>? notificationGate;
  Completer<void>? passwordGate;
  bool failNotifications = false;
  bool failPassword = false;
  bool failLegal = false;
  int notificationWrites = 0;
  int changes = 0;
  int erasures = 0;
  int legalReads = 0;
  final revoked = <String>[];
  final cursors = <String?>[];
  @override
  Future<Map<String, dynamic>> notificationPreferences({
    Map<String, dynamic>? update,
  }) async {
    if (update != null) notificationWrites++;
    if (failNotifications) throw const ApiException('offline', 503);
    if (notificationGate != null) return notificationGate!.future;
    return super.notificationPreferences(update: update);
  }

  @override
  Future<List<Map<String, dynamic>>> accountDevices() async => [
    {
      'id': 'other-device',
      'label': 'Other phone',
      'current': false,
      'lastSeenAt': '2026-09-07T00:00:00Z',
    },
    {
      'id': 'current-device',
      'label': 'Test phone',
      'current': true,
      'lastSeenAt': '2026-09-07T00:00:00Z',
    },
  ].where((v) => !revoked.contains(v['id'])).toList();
  @override
  Future<void> revokeDevice(String id, String requestKey) async {
    expect(requestKey, startsWith('device-'));
    revoked.add(id);
    if (id == 'current-device') await logout();
  }

  @override
  Future<void> changePassword(String current, String next) async {
    changes++;
    await passwordGate?.future;
    if (failPassword) throw const ApiException('wrong password', 401);
  }

  @override
  Future<void> requestAccountErasure(String password, String requestKey) async {
    erasures++;
    expect(requestKey, startsWith('erasure-'));
    await logout();
  }

  @override
  Future<Map<String, dynamic>> exportAccountData({
    required String password,
    required String section,
    String? cursor,
  }) async {
    expect(password, '  unchanged password  ');
    cursors.add(cursor);
    return {
      'section': section,
      'items': [
        {'id': cursor == null ? 'record-one' : 'record-two'},
      ],
      if (cursor == null) 'nextCursor': 'page-two',
    };
  }

  @override
  Future<List<Map<String, dynamic>>> legalDocuments(String locale) async {
    legalReads++;
    if (failLegal) throw const ApiException('offline', 503);
    return [
      {
        'title': 'Privacy policy',
        'version': 2,
        'bodyMarkdown': 'Actual tenant privacy text',
      },
    ];
  }
}

Future<AppController> openSettings(
  WidgetTester tester,
  SettingsFixture repo, {
  bool signedIn = true,
  double textScale = 1,
}) async {
  final controller = AppController(repo);
  await controller.initialize();
  if (signedIn) await controller.login(user.email, 'fixture-password');
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: SettingsPage(controller: controller),
    ),
  );
  await tester.pumpAndSettle();
  addTearDown(controller.dispose);
  return controller;
}

Future<void> tapSetting(WidgetTester tester, String title) async {
  final found = find.text(title);
  await tester.scrollUntilVisible(
    found,
    250,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
  await tester.ensureVisible(found);
  await tester.pumpAndSettle();
  await tester.tap(found);
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('nightflix/settings'),
          (call) async => switch (call.method) {
            'appInfo' => {
              'version': '1.2.3',
              'build': '42',
              'package': 'com.example.operator',
            },
            _ => true,
          },
        );
  });

  test(
    'simultaneous playback writes merge and persist after restart',
    () async {
      final controller = AppController(SettingsFixture());
      await controller.initialize();
      await Future.wait([
        controller.setPlaybackSettings(autoAdvance: false),
        controller.setPlaybackSettings(subtitlesEnabled: false),
        controller.setPlaybackSettings(speed: 0.75),
      ]);
      final restored = AppController(SettingsFixture());
      await restored.initialize();
      expect(restored.autoAdvance, isFalse);
      expect(restored.subtitlesEnabled, isFalse);
      expect(restored.playbackSpeed, .75);
      expect(
        () => controller.setPlaybackSettings(speed: 99),
        throwsArgumentError,
      );
      controller.dispose();
      restored.dispose();
    },
  );

  test('account requests preserve passwords, auth and idempotency without fake demo success', () async {
    final calls = <http.Request>[];
    await http.runWithClient(
      () async {
        final repo = DramaRepository(
          apiBaseUrl: 'https://settings.example.test',
        )..session = user;
        expect((await repo.accountDevices()).single['id'], 'device');
        await repo.changePassword('  current password  ', 'new password');
        await repo.exportAccountData(
          password: '  current password  ',
          section: 'orders',
          cursor: 'cursor-two',
        );
        await repo.revokeDevice('other', 'device-key');
        expect(repo.session, user);
        await repo.requestAccountErasure('  current password  ', 'erasure-key');
        expect(repo.session, isNull);
        await expectLater(repo.accountDevices(), throwsA(isA<ApiException>()));
        final baseDemo = DramaRepository(apiBaseUrl: '')..session = user;
        await expectLater(
          baseDemo.changePassword('old password', 'new password'),
          throwsA(isA<ApiException>()),
        );
        expect(baseDemo.session, user);
      },
      () => MockClient((r) async {
        calls.add(r);
        expect(r.headers['authorization'], 'Bearer token-a');
        if (r.url.path.endsWith('/devices')) {
          return http.Response('{"items":[{"id":"device"}]}', 200);
        }
        if (r.url.path.endsWith('/revoke')) {
          expect(
            r.headers['Idempotency-Key'] ?? r.headers['idempotency-key'],
            'device-key',
          );
          return http.Response(
            '{"revoked":true,"requiresReauthentication":false}',
            200,
          );
        }
        final body = jsonDecode(r.body) as Map;
        expect(body['currentPassword'], '  current password  ');
        if (r.url.path.endsWith('/erasure-requests')) {
          expect(body['acknowledgeRetention'], isTrue);
          expect(
            r.headers['Idempotency-Key'] ?? r.headers['idempotency-key'],
            'erasure-key',
          );
          return http.Response('{"status":"submitted"}', 202);
        }
        if (r.url.path.endsWith('/export')) {
          expect(body['cursor'], 'cursor-two');
          expect(body['pageSize'], 100);
        }
        return http.Response('{}', 200);
      }),
    );
    expect(calls, hasLength(5));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getKeys().any((key) => key.contains('password')), isFalse);
  });

  test('wrong password does not refresh or log out; revoked current device clears session', () async {
    final paths = <String>[];
    await http.runWithClient(
      () async {
        final repo = DramaRepository(
          apiBaseUrl: 'https://settings.example.test',
        )..session = user;
        await expectLater(
          repo.changePassword('wrong password', 'new password'),
          throwsA(isA<ApiException>()),
        );
        expect(repo.session, user);
        await repo.revokeDevice('current-device', 'current-key');
        expect(repo.session, isNull);
      },
      () => MockClient((r) async {
        paths.add(r.url.path);
        return r.url.path.endsWith('/revoke')
            ? http.Response('{"requiresReauthentication":true}', 200)
            : http.Response('{"message":"Current password invalid"}', 401);
      }),
    );
    expect(paths.where((p) => p.contains('refresh')), isEmpty);
  });

  testWidgets(
    'notification page loads, saves both values, retries and opens real settings channel',
    (tester) async {
      final repo = SettingsFixture()..failNotifications = true;
      await openSettings(tester, repo);
      await tapSetting(tester, 'Notification preferences');
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byType(SwitchListTile), findsNothing);
      repo.failNotifications = false;
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('In-app promotions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Push promotions'));
      await tester.pumpAndSettle();
      expect(repo.notificationWrites, 2);
      expect(await repo.notificationPreferences(), {
        'marketingInAppEnabled': false,
        'marketingPushEnabled': false,
      });
      await tester.tap(find.text('Open system settings'));
      await tester.pumpAndSettle();
      expect(find.text('Allowed'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'late notification read cannot display or write another account preferences',
    (tester) async {
      final gate = Completer<Map<String, dynamic>>();
      final repo = SettingsFixture()..notificationGate = gate;
      final controller = await openSettings(tester, repo);
      await tester.tap(find.text('Notification preferences'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      await controller.logout();
      await controller.login('b@example.test', 'fixture-password');
      gate.complete({
        'marketingInAppEnabled': true,
        'marketingPushEnabled': true,
      });
      await tester.pumpAndSettle();
      expect(
        find.text('Account changed. Please return to Settings.'),
        findsOneWidget,
      );
      expect(find.byType(SwitchListTile), findsNothing);
      expect(repo.notificationWrites, 0);
    },
  );

  testWidgets('guest account setting is login-gated', (tester) async {
    await openSettings(tester, SettingsFixture(), signedIn: false);
    await tapSetting(tester, 'Signed-in devices');
    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Other phone'), findsNothing);
  });

  testWidgets(
    'device revoke supports cancel, other-device removal, and current-device signout',
    (tester) async {
      final repo = SettingsFixture();
      await openSettings(tester, repo);
      await tapSetting(tester, 'Signed-in devices');
      await tester.tap(find.text('Sign out').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repo.revoked, isEmpty);
      await tester.tap(find.text('Sign out').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
      expect(repo.revoked, ['other-device']);
      expect(find.text('Other phone'), findsNothing);
      await tester.tap(find.text('Sign out').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
      expect(repo.session, isNull);
      expect(
        find.text('Account changed. Please return to Settings.'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'password form validates confirmation, blocks repeat submit, surfaces errors and retries',
    (tester) async {
      final repo = SettingsFixture()..failPassword = true;
      await openSettings(tester, repo);
      await tapSetting(tester, 'Change password');
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'current password');
      await tester.enterText(fields.at(1), 'new password');
      await tester.enterText(fields.at(2), 'wrong confirmation');
      await tester.tap(find.widgetWithText(FilledButton, 'Change password'));
      await tester.pumpAndSettle();
      expect(repo.changes, 0);
      expect(find.text('Passwords do not match'), findsOneWidget);
      await tester.enterText(fields.at(2), 'new password');
      await tester.tap(find.widgetWithText(FilledButton, 'Change password'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Current password is incorrect'),
        findsOneWidget,
      );
      repo.failPassword = false;
      repo.passwordGate = Completer<void>();
      await tester.tap(find.widgetWithText(FilledButton, 'Change password'));
      await tester.pump();
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Processing…'),
            )
            .onPressed,
        isNull,
      );
      repo.passwordGate!.complete();
      await tester.pumpAndSettle();
      expect(repo.changes, 2);
      expect(
        find.text('Password changed. Other sessions have been signed out.'),
        findsOneWidget,
      );
      expect(
        tester.widget<TextFormField>(fields.first).controller!.text,
        isEmpty,
      );
    },
  );

  testWidgets(
    'export paginates actual records and account switch removes sensitive page',
    (tester) async {
      final repo = SettingsFixture();
      final controller = await openSettings(tester, repo);
      await tapSetting(tester, 'Export personal data');
      await tester.enterText(
        find.byType(TextFormField),
        '  unchanged password  ',
      );
      await tester.tap(
        find.widgetWithText(FilledButton, 'Export personal data'),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('record-one'), findsOneWidget);
      await tapSetting(tester, 'Read next page');
      expect(repo.cursors, [null, 'page-two']);
      expect(find.textContaining('record-two'), findsOneWidget);
      expect(find.text('Read next page'), findsNothing);
      await controller.logout();
      await tester.pumpAndSettle();
      expect(find.textContaining('record-two'), findsNothing);
    },
  );

  testWidgets(
    'erasure requires acknowledgement and confirmation, says requested not fully erased',
    (tester) async {
      final repo = SettingsFixture();
      await openSettings(tester, repo);
      await tapSetting(tester, 'Delete account');
      final submit = find.widgetWithText(FilledButton, 'Delete account');
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tester.enterText(find.byType(TextFormField), 'current password');
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repo.erasures, 0);
      await tester.tap(submit);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
      expect(repo.erasures, 1);
      expect(repo.session, isNull);
      expect(find.textContaining('Deletion requested.'), findsOneWidget);
    },
  );

  testWidgets(
    'cache clear keeps session, history and favorites; about is real version and policies retry',
    (tester) async {
      final repo = SettingsFixture()..failLegal = true;
      final controller = await openSettings(tester, repo);
      await controller.toggleFavorite('demo-1');
      await controller.markWatched('demo-1');
      controller.assetUrls['image'] = 'https://cached.example.test';
      await tapSetting(tester, 'Clear image cache');
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
      expect(controller.assetUrls, isEmpty);
      expect(controller.favorites, contains('demo-1'));
      expect(controller.history, contains('demo-1'));
      expect(controller.session, isNotNull);
      await tapSetting(tester, 'About this app');
      expect(find.textContaining('1.2.3 (42)'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tapSetting(tester, 'Privacy policy and terms');
      expect(find.text('Retry'), findsOneWidget);
      repo.failLegal = false;
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Privacy policy'));
      await tester.pumpAndSettle();
      expect(find.text('Actual tenant privacy text'), findsOneWidget);
    },
  );

  testWidgets(
    'language, email reset, help and signout all have working navigation',
    (tester) async {
      final repo = SettingsFixture();
      final controller = await openSettings(tester, repo);
      await tapSetting(tester, 'Language');
      await tester.tap(find.text('简体中文'));
      await tester.pumpAndSettle();
      expect(controller.locale, 'zh-CN');
      expect(
        (await SharedPreferences.getInstance()).getString(':locale'),
        'zh-CN',
      );
      // This fixture keeps its MaterialApp English; the real DramaApp follows controller.locale.
      await tapSetting(tester, 'Change password');
      await tester.tap(find.text('Forgot password / Set a password by email'));
      await tester.pumpAndSettle();
      expect(find.text('Reset password'), findsWidgets);
      expect(find.text('Send code'), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tapSetting(tester, 'Help and support');
      expect(find.text('Contact support / My feedback'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tapSetting(tester, 'Sign out');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repo.session, isNotNull);
      await tapSetting(tester, 'Sign out');
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
      expect(repo.session, isNull);
    },
  );

  testWidgets('ad privacy SDK failure is surfaced and can be retried', (
    tester,
  ) async {
    final controller = await openSettings(tester, SettingsFixture());
    final ads = adsFor(controller)..privacyRequired = true;
    controller.notifyListeners();
    await tester.pumpAndSettle();
    var fails = true;
    var shown = 0;
    const channel = MethodChannel('plugins.flutter.io/google_mobile_ads/ump');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'UserMessagingPlatform#showPrivacyOptionsForm') {
        shown++;
        if (fails) throw PlatformException(code: '1', message: 'not loaded');
        return null;
      }
      return false;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(channel, null);
      ads.dispose();
    });
    await tapSetting(tester, 'Ad privacy choices');
    expect(
      find.text('Unable to complete this request. Please try again.'),
      findsOneWidget,
    );
    expect(ads.busy, isFalse);
    fails = false;
    await tapSetting(tester, 'Ad privacy choices');
    expect(shown, 2);
    expect(ads.busy, isFalse);
  });

  testWidgets('large-font settings remain navigable without overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await openSettings(tester, SettingsFixture(), textScale: 2);
    await tapSetting(tester, 'About this app');
    expect(find.textContaining('com.example.operator'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
