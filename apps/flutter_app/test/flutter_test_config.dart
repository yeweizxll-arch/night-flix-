import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart';

import 'fake_video.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VideoPlayerPlatform.instance = FakeVideoPlatform();
  });
  await testMain();
}
