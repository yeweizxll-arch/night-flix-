import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';

void main() {
  testWidgets(
    'focused comment input can close and reopen without a disposed controller',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final controller = AppController(DramaRepository(apiBaseUrl: ''));
      await controller.initialize();
      await tester.pumpWidget(DramaApp(controller: controller));
      await tester.pumpAndSettle();
      for (var i = 0; i < 3; i++) {
        await tester.tap(find.byIcon(Icons.chat_bubble_outline).first);
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), 'Unsubmitted draft');
        tester.view.viewInsets = const FakeViewPadding(bottom: 300);
        await tester.pump();
        expect(tester.takeException(), isNull);
        final field = tester.element(find.byType(TextField));
        Navigator.of(field).pop();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
        await tester.pump(const Duration(seconds: 1));
        expect(tester.takeException(), isNull);
        expect(find.byType(TextField), findsNothing);
        tester.view.resetViewInsets();
      }
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
}
