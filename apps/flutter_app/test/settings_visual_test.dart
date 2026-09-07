import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';

void main() {
  testWidgets('settings page visual evidence', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final sdk = Platform.environment['FLUTTER_ROOT'];
    if (sdk != null) {
      for (final entry in {
        'SF Pro Display': 'Roboto-Regular.ttf',
        'MaterialIcons': 'MaterialIcons-Regular.otf',
      }.entries) {
        await tester.runAsync(() async {
          final bytes = File(
            '$sdk/bin/cache/artifacts/material_fonts/${entry.value}',
          ).readAsBytesSync();
          final loader = FontLoader(entry.key)
            ..addFont(Future.value(ByteData.sublistView(bytes)));
          await loader.load();
        });
      }
    }
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Settings'));
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/settings.png'),
    );
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
}
