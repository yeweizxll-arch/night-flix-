// Real Android platform channels and Flutter screens, with isolated local accounts.
// Does not send email, alter real accounts, or call production services.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';

import 'real_features_smoke_test.dart' as playback;

void main() {
  playback.main();
  testWidgets(
    'Android settings renders Chinese and reads native version/permissions',
    (tester) async {
      const channel = MethodChannel('nightflix/settings');
      final info = await channel.invokeMapMethod<String, dynamic>('appInfo');
      expect(info?['version'], isNotEmpty);
      expect(info?['package'], 'com.nightflix.template');
      expect(int.tryParse('${info?['build']}'), isNotNull);
      expect(
        await channel.invokeMethod<bool>('notificationsAllowed'),
        isA<bool>(),
      );
      final controller = AppController(DramaRepository(apiBaseUrl: ''));
      await controller.initialize();
      await controller.setLocale('zh-CN');
      await controller.setPlaybackSettings(
        autoAdvance: false,
        subtitlesEnabled: true,
        speed: .75,
      );
      final capture = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('zh', 'CN'),
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          supportedLocales: const [Locale('zh', 'CN')],
          home: RepaintBoundary(
            key: capture,
            child: SettingsPage(controller: controller),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('自动播放下一集'), findsOneWidget);
      expect(find.text('0.75×'), findsOneWidget);
      final boundary =
          capture.currentContext!.findRenderObject() as RenderRepaintBoundary;
      final screenshot = await boundary.toImage(pixelRatio: 1);
      final png = await screenshot.toByteData(format: ui.ImageByteFormat.png);
      final imageFile = File(
        '${Directory.systemTemp.path}/nightflix-settings-zh.png',
      );
      await imageFile.writeAsBytes(png!.buffer.asUint8List());
      screenshot.dispose();
      await tester.scrollUntilVisible(find.text('关于应用'), 250);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('关于应用'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('关于应用'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('${info!['version']} (${info['build']})'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      // Verify that Android actually accepts this application-details Intent.
      expect(await channel.invokeMethod<bool>('openAppSettings'), isTrue);
    },
  );
}
