import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() => integrationDriver(
  writeResponseOnFailure: true,
  onScreenshot: (name, bytes, [args]) async {
    final directory = Directory('build/settings-emulator');
    await directory.create(recursive: true);
    await File('${directory.path}/$name.png').writeAsBytes(bytes);
    return bytes.isNotEmpty;
  },
);
