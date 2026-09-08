// Audit regression: the account sheet opened from the dark feed has a white
// surface; its title must not inherit the dark page's white DefaultTextStyle.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/account_sheet.dart';
import 'package:night_flix/src/drama_repository.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('login title remains readable when opened from dark player', (
    tester,
  ) async {
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await controller.setLocale('en-US');
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pump(const Duration(seconds: 1));
    final context = tester.element(find.byType(FeedScreen));
    final closed = showAccountSheet(
      context,
      controller,
      reason: 'QA title contrast',
    );
    await tester.pump(const Duration(milliseconds: 600));
    final title = tester.widget<RichText>(
      find.byWidgetPredicate(
        (widget) =>
            widget is RichText &&
            widget.text.toPlainText() == 'QA title contrast',
      ),
    );
    final color = title.text.style!.color!;
    debugPrint(
      'AUDIT login title color=$color luminance=${color.computeLuminance()}',
    );
    Navigator.of(tester.element(find.byType(AccountSheet))).pop(false);
    await tester.pump(const Duration(milliseconds: 600));
    await closed;
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    expect(
      color.computeLuminance(),
      lessThan(.5),
      reason: 'Dark text required on the white login sheet',
    );
  });
}
