// Runs real Android video playback and native OCR against deterministic local
// fixtures. API/database behavior is covered separately by PostgreSQL tests.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';
import 'package:video_player/video_player.dart';

class PlaybackFixture extends DramaRepository {
  PlaybackFixture() : super(apiBaseUrl: '');
  @override
  Future<List<Drama>> dramas({String locale = 'en-US', String? query}) async =>
      [
        Drama(
          id: 'native-drama',
          title: 'Native playback test',
          summary: 'Local test fixture',
          totalEpisodes: 20,
          episodes: List.generate(
            20,
            (i) => Episode(
              id: 'native-episode-$i',
              number: i + 1,
              title: 'Episode ${i + 1}',
              durationSeconds: 8,
              previewSeconds: 0,
              playbackUrl: 'asset://assets/demo/contract.mp4',
            ),
          ),
        ),
      ];
}

Future<void> until(
  WidgetTester tester,
  bool Function() ready,
  String reason,
) async {
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (ready()) return;
  }
  fail('Timed out: $reason');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android native playback, pause, resume, episode 10 and navigation',
    (tester) async {
      final controller = AppController(PlaybackFixture());
      await controller.initialize();
      await controller.setLocale('en-US');
      await controller.setPlaybackSettings(autoAdvance: false);
      await tester.pumpWidget(DramaApp(controller: controller));
      await until(
        tester,
        () => find.byType(VideoPlayer).evaluate().isNotEmpty,
        'first video',
      );
      VideoPlayerController player() =>
          tester.widget<VideoPlayer>(find.byType(VideoPlayer).first).controller;
      await until(
        tester,
        () => player().value.isInitialized && player().value.isPlaying,
        'playing',
      );
      await tester.tap(find.byKey(const Key('playback-toggle')));
      await until(tester, () => !player().value.isPlaying, 'pause');
      expect(find.byKey(const Key('paused-play-button')), findsOneWidget);
      await tester.tap(find.byKey(const Key('paused-play-button')));
      await until(tester, () => player().value.isPlaying, 'resume');
      final before = player();
      await tester.tap(find.textContaining('20 episodes').first);
      await until(
        tester,
        () =>
            find.byKey(const ValueKey('episode-cell-10')).evaluate().isNotEmpty,
        'episode selector',
      );
      await tester.tap(find.byKey(const ValueKey('episode-cell-10')));
      await until(
        tester,
        () =>
            find.byType(VideoPlayer).evaluate().isNotEmpty &&
            player() != before &&
            player().value.isPlaying,
        'episode 10',
      );
      expect(find.textContaining('10 / 20'), findsWidgets);
      await tester.tap(find.text('Me'));
      await until(
        tester,
        () => find.byIcon(Icons.settings_outlined).evaluate().isNotEmpty,
        'profile',
      );
      await tester.tap(find.byIcon(Icons.settings_outlined));
      await until(
        tester,
        () => find.text('Autoplay next episode').evaluate().isNotEmpty,
        'settings',
      );
      expect(
        tester
            .widget<SwitchListTile>(
              find.widgetWithText(SwitchListTile, 'Autoplay next episode'),
            )
            .value,
        isFalse,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 500));
    },
  );

  testWidgets('Android real on-device OCR reads a generated screenshot', (
    tester,
  ) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder)..drawColor(Colors.white, BlendMode.src);
    final text = TextPainter(
      text: const TextSpan(
        text: 'Night Flix Drama',
        style: TextStyle(color: Colors.black, fontSize: 60),
      ),
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: 1000);
    text.paint(canvas, const Offset(30, 45));
    final picture = recorder.endRecording();
    final image = await picture.toImage(1100, 180);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final directory = await Directory.systemTemp.createTemp(
      'nightflix-ocr-test-',
    );
    final file = File('${directory.path}/title.png');
    try {
      await file.writeAsBytes(data!.buffer.asUint8List());
      final result = await const MethodChannel('nightflix/text-recognition')
          .invokeListMethod<String>('recognize', {
            'path': file.path,
            'locale': 'en-US',
          });
      expect(result!.join(' ').toLowerCase(), contains('night flix drama'));
    } finally {
      image.dispose();
      picture.dispose();
      if (await file.exists()) await file.delete();
      await directory.delete();
    }
  });
}
