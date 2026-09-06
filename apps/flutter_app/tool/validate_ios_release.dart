import 'dart:convert';
import 'dart:io';

void main() {
  final env = Platform.environment;
  if (!(env['CONFIGURATION'] ?? '').toLowerCase().contains('release')) return;
  final defines = <String, String>{};
  for (final raw in (env['DART_DEFINES'] ?? '').split(',')) {
    if (raw.isEmpty) continue;
    final pair = utf8.decode(base64.decode(raw)).split('=');
    defines[pair.first] = pair.skip(1).join('=');
  }
  final api = Uri.tryParse(defines['API_BASE_URL'] ?? '');
  final bundle = env['PRODUCT_BUNDLE_IDENTIFIER'] ?? '';
  final team = env['DEVELOPMENT_TEAM'] ?? '';
  final info = File('${env['SRCROOT']}/Runner/Info.plist').readAsStringSync();
  if (api?.scheme != 'https' ||
      api?.host.isNotEmpty != true ||
      api?.userInfo.isNotEmpty == true ||
      defines['DEMO_MODE'] == 'true' ||
      bundle.isEmpty ||
      bundle.startsWith('com.nightflix.template') ||
      !RegExp(r'^[A-Z0-9]{10}$').hasMatch(team) ||
      env['CODE_SIGNING_ALLOWED'] == 'NO' ||
      info.contains('ca-app-pub-3940256099942544')) {
    stderr.writeln(
      'Release blocked: tenant API, bundle ID, team, signing and AdMob App ID are required.',
    );
    exitCode = 1;
  }
}
