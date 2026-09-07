// Real Android UI, native preferences/keystore and local Nest/PostgreSQL APIs.
// Run with the opt-in settings-emulator.integration.spec.ts server (port 4326).
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:http/http.dart' as http;
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/account_sheet.dart';
import 'package:night_flix/src/app_strings.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

const base = 'http://127.0.0.1:4326';
const initialPassword = 'Local-password-123';
late final IntegrationTestWidgetsFlutterBinding binding;
final captureKey = GlobalKey();

Future<Map<String, dynamic>> qa(
  String path, [
  Map<String, dynamic>? data,
]) async {
  final uri = Uri.parse('$base/__qa/$path');
  final response = data == null
      ? await http.get(uri)
      : await http.post(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode(data),
        );
  expect(response.statusCode, 200, reason: response.body);
  return jsonDecode(response.body) as Map<String, dynamic>;
}

Future<void> ready(WidgetTester tester) async {
  await tester.pumpAndSettle(
    const Duration(milliseconds: 100),
    EnginePhase.sendSemanticsUpdate,
    const Duration(seconds: 25),
  );
  // Native HTTP can still be in flight after a static "Processing" button has
  // rendered. Waiting only for animation frames creates false pass/fail races.
  for (var attempt = 0; attempt < 250; attempt++) {
    if (find.text('Processing…').evaluate().isEmpty &&
        find.text('处理中…').evaluate().isEmpty &&
        find.byType(CircularProgressIndicator).evaluate().isEmpty &&
        find.byType(LinearProgressIndicator).evaluate().isEmpty) {
      break;
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
  expect(find.text('Processing…'), findsNothing);
  expect(find.text('处理中…'), findsNothing);
  expect(find.byType(CircularProgressIndicator), findsNothing);
  expect(find.byType(LinearProgressIndicator), findsNothing);
  expect(tester.takeException(), isNull);
}

Future<void> tap(WidgetTester tester, String label) async {
  // Scaffold traversal can place the AppBar after the body. A page title is
  // not its identically named submit button.
  final submit = find.widgetWithText(FilledButton, label);
  if (submit.evaluate().isNotEmpty) {
    await tester.pump(const Duration(milliseconds: 400));
    await ready(tester);
  }
  final target = submit.evaluate().isNotEmpty
      ? submit.last
      : find.text(label).last;
  await tester.ensureVisible(target);
  await ready(tester);
  await tester.tap(target);
  await ready(tester);
}

Future<void> setting(WidgetTester tester, String label) async {
  await tester.scrollUntilVisible(
    find.text(label).last,
    250,
    scrollable: find.byType(Scrollable).first,
  );
  await tap(tester, label);
}

Future<void> back(WidgetTester tester) async {
  await tester.binding.handlePopRoute();
  await ready(tester);
}

Future<void> nativeCheckpoint(
  WidgetTester tester,
  String action,
  String button,
) async {
  await qa('native', {'action': action});
  await tester.ensureVisible(find.text(button));
  await tester.tap(find.text(button));
  for (var attempt = 0; attempt < 100; attempt++) {
    final state = await qa('native');
    if (state['done'] == true) {
      expect(state['error'], isNull);
      await ready(tester);
      return;
    }
    await tester.pump(const Duration(milliseconds: 200));
  }
  fail('Native $action checkpoint timed out');
}

Future<void> capture(WidgetTester tester, String name) async {
  await ready(tester);
  final boundary =
      captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: 1);
  try {
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await qa('screenshots/$name', {
      'png': base64Encode(bytes!.buffer.asUint8List()),
    });
  } finally {
    image.dispose();
  }
}

Future<AppController> open(
  WidgetTester tester, {
  String? account,
  String password = initialPassword,
}) async {
  final repo = DramaRepository(apiBaseUrl: base);
  final controller = AppController(repo);
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
  await controller.initialize();
  expect(controller.error, isNull);
  if (controller.session != null) await controller.logout();
  await controller.setLocale('en-US');
  if (account != null) {
    await controller.login('$account@example.test', password);
  }
  await tester.pumpWidget(
    RepaintBoundary(
      key: captureKey,
      child: DramaApp(controller: controller),
    ),
  );
  await ready(tester);
  await tap(tester, 'Me');
  await setting(tester, 'Settings');
  return controller;
}

void main() {
  binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    // Only this test API's local preference keys are cleared; native keystore is real.
    final preferences = await SharedPreferences.getInstance();
    for (final key in preferences.getKeys().where((k) => k.startsWith(base))) {
      await preferences.remove(key);
    }
  });

  testWidgets(
    'all playback options, guest gate, languages, native info and restart persistence',
    (tester) async {
      final controller = await open(tester);
      await capture(tester, '01-settings-en');
      await tap(tester, 'Autoplay next episode');
      await tap(tester, 'Show subtitles by default');
      expect(controller.autoAdvance, isFalse);
      expect(controller.subtitlesEnabled, isFalse);
      for (final speed in playbackSpeeds) {
        await tester.tap(find.byType(DropdownButton<double>));
        await ready(tester);
        await tap(tester, '$speed×');
        expect(controller.playbackSpeed, speed);
      }
      await setting(tester, 'Signed-in devices');
      expect(find.text('Welcome back'), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await ready(tester);
      await setting(tester, 'Language');
      await tap(tester, '简体中文');
      expect(controller.locale, 'zh-CN');
      await setting(tester, '自动播放下一集');
      await capture(tester, '02-settings-zh');
      final restored = AppController(DramaRepository(apiBaseUrl: base));
      await restored.initialize();
      expect(restored.locale, 'zh-CN');
      expect(restored.autoAdvance, isTrue);
      expect(restored.subtitlesEnabled, isFalse);
      expect(restored.playbackSpeed, 2);
      restored.dispose();
      await setting(tester, '关于应用');
      final native = await const MethodChannel('nightflix/settings')
          .invokeMapMethod<String, dynamic>('appInfo');
      expect(
        find.textContaining('${native!['version']} (${native['build']})'),
        findsOneWidget,
      );
      await capture(tester, '03-about-zh');
      await back(tester);
      await setting(tester, '语言');
      await tap(tester, 'English');
    },
  );

  testWidgets(
    'every configured language can be selected, including Chinese and RTL',
    (tester) async {
      final controller = await open(tester);
      for (final locale in controller.config.supportedLocales) {
        final title = translateAppString(
          localeFromTag(controller.locale),
          'language',
          'Language',
        );
        await setting(tester, title);
        await tester.scrollUntilVisible(
          find.text(localeNames[locale]!),
          200,
          scrollable: find.byType(Scrollable).last,
        );
        await tap(tester, localeNames[locale]!);
        expect(controller.locale, locale);
        if (['ar-SA', 'hi-IN', 'zh-TW'].contains(locale)) {
          await capture(tester, 'language-${locale.toLowerCase()}');
        }
      }
    },
  );

  testWidgets(
    'guest registration validates OTP and real legal consent then resumes settings',
    (tester) async {
      final controller = await open(tester);
      await setting(tester, 'Change password');
      await tap(tester, 'Create account');
      final fields = find.descendant(
        of: find.byType(AccountSheet),
        matching: find.byType(TextField),
      );
      await tester.enterText(fields.at(0), 'signup@example.test');
      await tester.enterText(fields.at(1), 'signup');
      await tester.enterText(fields.at(2), initialPassword);
      await qa('fail-next', {'path': '/api/v1/customer/auth/otp/challenges'});
      await tap(tester, 'Send code');
      expect(find.text('Send code'), findsOneWidget);
      await tap(tester, 'Send code');
      final code =
          (await qa(
                'code?email=signup%40example.test&purpose=verify_email',
              ))['code']
              as String;
      await tester.enterText(
        fields.at(3),
        code == '000000' ? '111111' : '000000',
      );
      await tap(tester, 'QA Privacy Policy');
      expect(
        find.textContaining('Local test document: privacy.'),
        findsOneWidget,
      );
      await tap(tester, 'Close');
      await tester.ensureVisible(find.byType(CheckboxListTile));
      await tester.tap(find.byType(CheckboxListTile));
      await ready(tester);
      await tap(tester, 'Create account');
      expect(controller.session, isNull);
      await tester.enterText(fields.at(3), code);
      await ready(tester);
      expect(tester.widget<TextField>(fields.at(3)).controller!.text, code);
      await tap(tester, 'Create account');
      await capture(tester, 'registration-submit');
      expect(controller.session?.email, 'signup@example.test');
      expect(find.text('Current password'), findsOneWidget);
      expect(
        (await qa('state'))['accounts'],
        contains(equals({'username': 'signup', 'status': 'active'})),
      );
      await capture(tester, 'registration-return');
    },
  );

  testWidgets(
    'notifications real GET/PUT, failure rollback, retry and reload',
    (tester) async {
      final controller = await open(tester, account: 'notifications');
      await qa('fail-next', {
        'path': '/api/v1/customer/notifications/preferences',
      });
      await setting(tester, 'Notification preferences');
      expect(find.text('Retry'), findsOneWidget);
      await tap(tester, 'Retry');
      expect(find.byType(SwitchListTile), findsNWidgets(2));
      await qa('fail-next', {
        'path': '/api/v1/customer/notifications/preferences',
      });
      await tap(tester, 'In-app promotions');
      expect(
        tester.widget<SwitchListTile>(find.byType(SwitchListTile).first).value,
        isTrue,
      );
      await tap(tester, 'Retry');
      await tap(tester, 'In-app promotions');
      await tap(tester, 'Push promotions');
      expect(
        (await qa('state'))['preferences'],
        contains(
          equals({
            'marketing_in_app_enabled': false,
            'marketing_push_enabled': false,
          }),
        ),
      );
      await capture(tester, '04-notifications');
      await back(tester);
      await setting(tester, 'Notification preferences');
      for (final tile in tester.widgetList<SwitchListTile>(
        find.byType(SwitchListTile),
      )) {
        expect(tile.value, isFalse);
      }
      expect(
        await const MethodChannel('nightflix/settings')
            .invokeMethod<bool>('notificationsAllowed'),
        isA<bool>(),
      );
      expect(controller.session, isNotNull);
    },
  );

  testWidgets(
    'devices cancel/revoke, password validation, wrong password and actual new login',
    (tester) async {
      final controller = await open(tester, account: 'password');
      final otherLogin = await http.post(
        Uri.parse('$base/api/v1/customer/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'identifier': 'password@example.test',
          'password': initialPassword,
          'devicePlatform': 'web',
          'deviceLabel': 'Other phone',
        }),
      );
      expect(otherLogin.statusCode, 200);
      await setting(tester, 'Signed-in devices');
      expect(find.text('This device'), findsOneWidget);
      expect(find.text('Sign out'), findsNWidgets(2));
      await capture(tester, '05-devices');
      final otherButton = find.descendant(
        of: find.ancestor(
          of: find.text('Other phone'),
          matching: find.byType(Card),
        ),
        matching: find.byType(OutlinedButton),
      );
      await tester.tap(otherButton);
      await ready(tester);
      await capture(tester, '05-device-confirmation');
      await tap(tester, 'Cancel');
      expect(find.text('Sign out'), findsNWidgets(2));
      await tester.tap(otherButton);
      await ready(tester);
      await tap(tester, 'Confirm');
      expect(find.text('Sign out'), findsOneWidget);
      await back(tester);
      await setting(tester, 'Change password');
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'wrong-password');
      await tester.enterText(fields.at(1), 'Local-new-password-456');
      await tester.enterText(fields.at(2), 'mismatch');
      await tap(tester, 'Change password');
      expect(find.text('Passwords do not match'), findsOneWidget);
      await tester.enterText(fields.at(2), 'Local-new-password-456');
      await tap(tester, 'Change password');
      expect(
        find.textContaining('Current password is incorrect'),
        findsOneWidget,
      );
      await tester.enterText(fields.at(0), initialPassword);
      await tap(tester, 'Change password');
      await capture(tester, '06-password-success');
      expect(
        find.text('Password changed. Other sessions have been signed out.'),
        findsOneWidget,
      );
      final other = DramaRepository(apiBaseUrl: base);
      await expectLater(
        other.login('password@example.test', initialPassword),
        throwsA(isA<ApiException>()),
      );
      await other.login('password@example.test', 'Local-new-password-456');
      await other.logout();
      expect(controller.session, isNotNull);
    },
  );

  testWidgets(
    'reset password uses real OTP verification and returns to signed-in settings',
    (tester) async {
      final controller = await open(tester, account: 'reset');
      await setting(tester, 'Change password');
      await tap(tester, 'Forgot password / Set a password by email');
      expect(find.text('reset@example.test'), findsOneWidget);
      await tap(tester, 'Send code');
      final code = (await qa(
        'code?email=reset%40example.test&purpose=password_reset',
      ))['code'];
      expect(code, matches(RegExp(r'^\d{6}$')));
      final fields = find.byType(TextField).hitTestable();
      // Hidden password-change page fields are not part of this bottom sheet.
      await tester.enterText(fields.at(1), '新密码');
      await tester.enterText(fields.at(2), '$code');
      await tap(tester, 'Reset password');
      expect(find.text('Send code'), findsNothing);
      expect(controller.session?.email, 'reset@example.test');
      // The automatic sign-in after OTP reset must accept the exact new password.
      final check = await http.post(
        Uri.parse('$base/api/v1/customer/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'identifier': 'reset@example.test',
          'password': '新密码',
          'devicePlatform': 'web',
          'deviceLabel': 'Reset verification',
        }),
      );
      expect(check.statusCode, 200);
      await capture(tester, '07-reset-return');
    },
  );

  testWidgets(
    'export, all data categories, legal retry, help feedback and cache preservation',
    (tester) async {
      final controller = await open(tester, account: 'export');
      await setting(tester, 'Export personal data');
      await tester.enterText(find.byType(TextFormField).last, initialPassword);
      await tap(tester, 'Export personal data');
      expect(find.textContaining('export@example.test'), findsOneWidget);
      await capture(tester, '08-export');
      for (final section in [
        'Consent records',
        'Orders',
        'Comments',
        'Bullet comments',
        'Watch history',
        'Favorites',
        'Following',
        'Feedback',
        'Messages',
      ]) {
        await tester.ensureVisible(
          find.byType(DropdownButtonFormField<String>),
        );
        await tester.tap(find.byType(DropdownButtonFormField<String>));
        await ready(tester);
        await tap(tester, section);
        await tap(tester, 'Export personal data');
        expect(find.text('Save / share current page'), findsOneWidget);
        if (section == 'Feedback') {
          await tap(tester, 'Read next page');
          expect(find.textContaining('Fixture feedback 101'), findsOneWidget);
          expect(find.text('Read next page'), findsNothing);
        }
      }
      await back(tester);
      await qa('fail-next', {'path': '/api/v1/customer/legal'});
      await setting(tester, 'Privacy policy and terms');
      expect(find.text('Retry'), findsOneWidget);
      await tap(tester, 'Retry');
      await tap(tester, 'QA Privacy Policy');
      expect(
        find.textContaining('Local test document: privacy.'),
        findsOneWidget,
      );
      await capture(tester, '09-legal');
      await back(tester);
      await setting(tester, 'Help and support');
      for (final question in [
        'Which email addresses can I use?',
        'How do unlocks work?',
        'How do I restore on another device?',
      ]) {
        await tap(tester, question);
        await tap(tester, question);
      }
      await tap(tester, 'Contact support / My feedback');
      await tester.enterText(
        find.byType(TextField),
        'Emulator feedback: settings end-to-end verified.',
      );
      await tap(tester, 'Send');
      expect(
        (await qa('state'))['feedback'],
        contains(
          equals({'body': 'Emulator feedback: settings end-to-end verified.'}),
        ),
      );
      await capture(tester, '10-feedback');
      await back(tester);
      await back(tester);
      final account = controller.session!.accountId;
      controller.assetUrls['fixture-cover'] = 'http://127.0.0.1/fixture.png';
      await setting(tester, 'Clear image cache');
      await tap(tester, 'Cancel');
      expect(controller.assetUrls, isNotEmpty);
      await setting(tester, 'Clear image cache');
      await tap(tester, 'Confirm');
      expect(controller.assetUrls, isEmpty);
      expect(controller.session!.accountId, account);
      expect((await controller.repository.feedback())['items'], isNotEmpty);
      // Allow the cache-cleared snackbar to leave before tapping the bottom row.
      await tester.pump(const Duration(seconds: 5));
      await ready(tester);
      await setting(tester, 'Sign out');
      await tap(tester, 'Cancel');
      expect(controller.session, isNotNull);
      await setting(tester, 'Sign out');
      await tap(tester, 'Confirm');
      expect(controller.session, isNull);
    },
  );

  testWidgets(
    'native system settings and JSON export share open and return safely',
    (tester) async {
      final controller = await open(tester, account: 'viewer');
      await setting(tester, 'Notification preferences');
      await nativeCheckpoint(tester, 'system-settings', 'Open system settings');
      expect(find.text('System notification permission'), findsOneWidget);
      await back(tester);
      await setting(tester, 'Export personal data');
      await tester.enterText(find.byType(TextFormField), initialPassword);
      await tap(tester, 'Export personal data');
      await nativeCheckpoint(
        tester,
        'share-export',
        'Save / share current page',
      );
      expect(find.textContaining('viewer@example.test'), findsOneWidget);
      expect(controller.session, isNotNull);
    },
  );

  testWidgets(
    'delete account cancel, actual disable and rejected subsequent login',
    (tester) async {
      final controller = await open(tester, account: 'erase');
      await setting(tester, 'Delete account');
      await tester.enterText(find.byType(TextFormField), initialPassword);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Delete account'),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(find.byType(CheckboxListTile));
      await ready(tester);
      await tap(tester, 'Delete account');
      await capture(tester, '11-erasure-confirm');
      await tap(tester, 'Cancel');
      expect((await qa('state'))['erasures'], isEmpty);
      await tap(tester, 'Delete account');
      await tap(tester, 'Confirm');
      expect(controller.session, isNull);
      final state = await qa('state');
      expect(
        state['accounts'],
        contains(equals({'username': 'erase', 'status': 'erasure_pending'})),
      );
      expect(state['erasures'], hasLength(1));
      await expectLater(
        controller.login('erase@example.test', initialPassword),
        throwsA(isA<ApiException>()),
      );
      await capture(tester, '12-erasure-result');
    },
  );
}
