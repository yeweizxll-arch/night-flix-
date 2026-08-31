import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:shanchuang_drama/src/app.dart';
import 'package:shanchuang_drama/src/drama_repository.dart';
import 'package:shanchuang_drama/src/models.dart';

void main() {
  test('runtime configuration safely falls back to app defaults', () {
    final config = AppRuntimeConfig.fromJson(const {'siteName': 'Agent One'});
    expect(config.siteName, 'Agent One');
    expect(config.defaultLocale, 'en-US');
    expect(config.admobEnabled, isFalse);
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
  });
}
