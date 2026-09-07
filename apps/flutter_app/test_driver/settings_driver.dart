import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  // Native dialogs are outside Flutter's widget tree. Verify the real activity,
  // retain an adb screenshot, then cancel it; never send the exported file.
  final sdk =
      Platform.environment['ANDROID_HOME'] ??
      Platform.environment['ANDROID_SDK_ROOT'];
  final adb = sdk == null ? 'adb' : '$sdk/platform-tools/adb';
  final serial =
      Platform.environment['NIGHTFLIX_TEST_DEVICE'] ?? 'emulator-5554';
  if (!serial.startsWith('emulator-')) throw StateError('Local emulator only');
  final uri = Uri.parse('http://127.0.0.1:4326/__qa/native');
  var busy = false;
  Future<void> checkpoint() async {
    if (busy) return;
    busy = true;
    try {
      final state = jsonDecode((await http.get(uri)).body) as Map;
      final action = state['action'];
      if (action == null || state['done'] == true) return;
      final expected = action == 'system-settings'
          ? 'com.android.settings'
          : 'ChooserActivity';
      var visible = false;
      for (var attempt = 0; attempt < 40; attempt++) {
        final result = await Process.run(adb, [
          '-s',
          serial,
          'shell',
          'dumpsys',
          'activity',
          'activities',
        ]);
        visible = '${result.stdout}'
            .split('\n')
            .any(
              (line) =>
                  line.contains('mResumedActivity') && line.contains(expected),
            );
        if (visible) break;
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
      if (!visible) throw StateError('Native $action did not open');
      final shot = await Process.run(adb, [
        '-s',
        serial,
        'exec-out',
        'screencap',
        '-p',
      ], stdoutEncoding: null);
      final directory = Directory('build/settings-emulator');
      await directory.create(recursive: true);
      await File('${directory.path}/native-$action.png')
          .writeAsBytes(shot.stdout as List<int>);
      await Process.run(adb, [
        '-s',
        serial,
        'shell',
        'input',
        'keyevent',
        'KEYCODE_BACK',
      ]);
      await http.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: '{"done":true}',
      );
    } catch (error) {
      try {
        await http.post(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'done': true, 'error': '$error'}),
        );
      } catch (_) {}
    } finally {
      busy = false;
    }
  }

  final timer = Timer.periodic(
    const Duration(milliseconds: 300),
    (_) => unawaited(checkpoint()),
  );
  try {
    await integrationDriver(writeResponseOnFailure: true);
  } finally {
    timer.cancel();
  }
}
