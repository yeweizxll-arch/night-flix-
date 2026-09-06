import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart';

class FakeVideoPlatform extends VideoPlayerPlatform {
  FakeVideoPlatform({this.size = const Size(360, 640)});
  final Size size;
  final playing = <int>{};
  final positions = <int, Duration>{};
  final sources = <int, DataSource>{};
  final events = <int, StreamController<VideoEvent>>{};
  int sequence = 0;
  @override
  Future<void> init() async {}
  @override
  Future<int?> createWithOptions(VideoCreationOptions options) async {
    final id = ++sequence;
    sources[id] = options.dataSource;
    events[id] = StreamController<VideoEvent>.broadcast(
      sync: true,
      onListen: () {
        scheduleMicrotask(
          () => events[id]?.add(
            VideoEvent(
              eventType: VideoEventType.initialized,
              duration: const Duration(seconds: 60),
              size: size,
            ),
          ),
        );
      },
    );
    return id;
  }

  @override
  Stream<VideoEvent> videoEventsFor(int playerId) => events[playerId]!.stream;
  @override
  Future<void> dispose(int playerId) async {
    playing.remove(playerId);
    sources.remove(playerId);
    await events.remove(playerId)?.close();
  }

  @override
  Future<void> play(int playerId) async {
    playing.add(playerId);
  }

  @override
  Future<void> pause(int playerId) async {
    playing.remove(playerId);
  }

  @override
  Future<void> seekTo(int playerId, Duration position) async {
    positions[playerId] = position;
  }

  @override
  Future<Duration> getPosition(int playerId) async =>
      positions[playerId] ?? Duration.zero;
  @override
  Future<void> setLooping(int playerId, bool looping) async {}
  @override
  Future<void> setVolume(int playerId, double volume) async {}
  @override
  Future<void> setPlaybackSpeed(int playerId, double speed) async {}
  @override
  Widget buildViewWithOptions(VideoViewOptions options) =>
      const SizedBox.expand();
}
