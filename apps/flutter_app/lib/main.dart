import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

import 'src/app.dart';
import 'src/drama_repository.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const apiBaseUrl = String.fromEnvironment('API_BASE_URL');
  if (kReleaseMode &&
      (Uri.tryParse(apiBaseUrl)?.scheme != 'https' ||
          Uri.tryParse(apiBaseUrl)?.host.isNotEmpty != true)) {
    runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(
            child: Text(
              'Invalid release configuration. Contact the app operator.',
            ),
          ),
        ),
      ),
    );
    return;
  }
  final controller = AppController(DramaRepository(apiBaseUrl: apiBaseUrl));
  await controller.initialize();
  runApp(DramaApp(controller: controller));
}
