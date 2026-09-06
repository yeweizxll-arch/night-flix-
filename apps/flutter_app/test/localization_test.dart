import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/app_strings.dart';
import 'package:night_flix/src/app_translations.dart';
import 'package:night_flix/src/drama_repository.dart';

void main() {
  test('all supported locales translate every UI dictionary key', () {
    expect(appTranslations.keys.toSet(), localeNames.keys.toSet());
    for (final entry in appTranslations.entries) {
      expect(
        entry.value.keys.toSet(),
        appTranslations['en-US']!.keys.toSet(),
        reason: entry.key,
      );
      expect(entry.value.values, everyElement(isNotEmpty), reason: entry.key);
      if (entry.key != 'en-US') {
        expect(entry.value['forYou'], isNot('For You'), reason: entry.key);
      }
    }
    expect(translateAppString(const Locale('zh', 'TW'), 'library', ''), '片庫');
    expect(translateAppString(const Locale('zh', 'CN'), 'library', ''), '片库');
    expect(translateAppString(const Locale('xx'), 'library', ''), 'Library');
  });
  testWidgets(
    'Arabic resolves right-to-left layout and translated navigation',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final app = AppController(DramaRepository(apiBaseUrl: ''));
      await app.initialize();
      await app.setLocale('ar-SA');
      await tester.pumpWidget(DramaApp(controller: app));
      await tester.pumpAndSettle();
      expect(
        Directionality.of(tester.element(find.byType(AppShell))),
        TextDirection.rtl,
      );
      expect(find.text(appTranslations['ar-SA']!['library']!), findsOneWidget);
    },
  );
}
