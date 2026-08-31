import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import 'src/app.dart';
import 'src/drama_repository.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const apiBaseUrl = String.fromEnvironment('API_BASE_URL');
  final controller = AppController(DramaRepository(apiBaseUrl: apiBaseUrl));
  await controller.initialize();
  if (controller.config.admobEnabled) await MobileAds.instance.initialize();
  runApp(DramaApp(controller: controller));
}
