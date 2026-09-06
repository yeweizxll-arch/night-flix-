import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart';
import 'package:night_flix/src/app.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';
import 'package:night_flix/src/player_controls.dart';

import 'fake_video.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('feed, search and categories load all 102 dramas including page 2 vertical dramas', () async {
    final pages = <int>[];
    final client = MockClient((request) async {
      final page = int.parse(request.url.queryParameters['page']!);
      expect(request.url.queryParameters['pageSize'], '50');
      pages.add(page);
      return http.Response(
        jsonEncode({
          'total': 102,
          'items': List.generate(
            page == 3 ? 2 : 50,
            (index) => {
              'id': '${(page - 1) * 50 + index}',
              'title': page == 2 ? 'Vertical' : 'Landscape',
              'totalEpisodes': 24,
            },
          ),
        }),
        200,
      );
    });
    await http.runWithClient(() async {
      final repository = DramaRepository(apiBaseUrl: 'https://test.example');
      for (final result in [
        await repository.dramas(),
        await repository.dramas(query: 'test'),
        await repository.categoryDramas('test', 'en-US'),
      ]) {
        expect(result.length, 102);
        expect(result[50].title, 'Vertical');
        expect(result.map((e) => e.id).toSet().length, 102);
      }
    }, () => client);
    expect(pages, [1, 2, 3, 1, 2, 3, 1, 2, 3]);
  });

  test(
    'pagination fails explicitly on repeated pages instead of looping forever',
    () async {
      final client = MockClient(
        (_) async => http.Response(
          jsonEncode({
            'total': 102,
            'items': [
              {'id': 'same', 'title': 'Same'},
            ],
          }),
          200,
        ),
      );
      await http.runWithClient(() async {
        await expectLater(
          DramaRepository(apiBaseUrl: 'https://test.example').dramas(),
          throwsA(isA<ApiException>()),
        );
      }, () => client);
    },
  );

  testWidgets('16:9 frame stays 16:9 without cropping in portrait', (
    tester,
  ) async {
    VideoPlayerPlatform.instance = FakeVideoPlatform(
      size: const Size(1920, 1080),
    );
    tester.view.physicalSize = const Size(360, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = AppController(DramaRepository(apiBaseUrl: ''));
    await controller.initialize();
    await tester.pumpWidget(DramaApp(controller: controller));
    await tester.pumpAndSettle();
    final size = tester.getSize(find.byType(VideoPlayer).first);
    expect(size.width, closeTo(360, .01));
    expect(size.height, closeTo(202.5, .01));
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets(
    'selected episode differs from neutral cells; actual two/three digit numbers never wrap',
    (tester) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final drama = Drama(
        id: 'drama',
        title: 'Episode selection',
        summary: '',
        totalEpisodes: 3,
        episodes: [
          for (final n in [9, 10, 100])
            Episode(
              id: 'e$n',
              number: n,
              title: '',
              durationSeconds: 60,
              previewSeconds: 0,
            ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark(),
          home: Scaffold(
            body: EpisodePicker(drama: drama, currentId: 'e10'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final selected = tester.widget<Material>(
        find.byKey(const ValueKey('episode-cell-10')),
      );
      final other = tester.widget<Material>(
        find.byKey(const ValueKey('episode-cell-9')),
      );
      expect(selected.color, isNot(other.color));
      expect(find.byIcon(Icons.equalizer), findsOneWidget);
      for (final n in ['10', '100']) {
        final text = tester.widget<Text>(find.text(n));
        expect(text.softWrap, false);
        expect(text.maxLines, 1);
        final paragraph = tester.renderObject<RenderParagraph>(find.text(n));
        expect(paragraph.didExceedMaxLines, false);
      }
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/episode-picker-320.png'),
      );
    },
  );

  testWidgets(
    'tap through overlays pauses, paused icon resumes, background preserves manual pause',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = AppController(DramaRepository(apiBaseUrl: ''));
      await controller.initialize();
      await tester.pumpWidget(DramaApp(controller: controller));
      await tester.pumpAndSettle();
      final platform = VideoPlayerPlatform.instance as FakeVideoPlatform;
      expect(platform.playing, isNotEmpty);
      await tester.tapAt(const Offset(195, 250));
      await tester.pumpAndSettle();
      expect(platform.playing, isEmpty);
      expect(find.byKey(const Key('paused-play-button')), findsOneWidget);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(platform.playing, isEmpty);
      await expectLater(
        find.byType(DramaApp),
        matchesGoldenFile('goldens/player-paused-390.png'),
      );
      await tester.tap(find.byKey(const Key('paused-play-button')));
      await tester.pumpAndSettle();
      expect(platform.playing, isNotEmpty);
      expect(find.byKey(const Key('paused-play-button')), findsNothing);
      await tester.tap(find.byKey(const Key('playback-toggle')));
      await tester.pumpAndSettle();
      expect(platform.playing, isEmpty);
      final slider = tester.widget<Slider>(
        find.byKey(const Key('playback-seek')),
      );
      slider.onChanged!(30000);
      slider.onChangeEnd!(30000);
      await tester.pumpAndSettle();
      expect(platform.positions.values, contains(const Duration(seconds: 30)));
      expect(platform.playing, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );
}
