import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';

import 'drama_repository.dart';

String? linkedDramaId(Uri link, String? tenantHost) {
  if (tenantHost == null ||
      link.scheme != 'https' ||
      link.host != tenantHost ||
      link.userInfo.isNotEmpty ||
      (link.hasPort && link.port != 443) ||
      link.hasQuery ||
      link.hasFragment ||
      link.pathSegments.length != 2 ||
      link.pathSegments[0] != 'dramas') {
    return null;
  }
  final id = link.pathSegments[1];
  return RegExp(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        caseSensitive: false,
      ).hasMatch(id)
      ? id
      : null;
}

Future<bool> initializeTenantFirebase() async {
  const encoded = String.fromEnvironment('FIREBASE_OPTIONS');
  if (encoded.isEmpty) return false;
  if (Firebase.apps.isNotEmpty) return true;
  final map = jsonDecode(encoded) as Map<String, dynamic>;
  await Firebase.initializeApp(
    options: FirebaseOptions(
      apiKey: map['apiKey'] as String,
      appId: map['appId'] as String,
      messagingSenderId: map['messagingSenderId'] as String,
      projectId: map['projectId'] as String,
      iosBundleId: map['iosBundleId'] as String?,
    ),
  );
  return true;
}

@pragma('vm:entry-point')
Future<void> tenantPushBackground(RemoteMessage message) async {
  // Background notifications never navigate or execute arbitrary URLs.
  await initializeTenantFirebase();
}

class MobileLinks with WidgetsBindingObserver {
  MobileLinks(this.controller, this.openDrama);
  final AppController controller;
  final void Function(String id) openDrama;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  bool _disposed = false;
  bool _firebaseReady = false;
  bool _registering = false;
  String? _registeredKey;
  String? _lastLink;
  DateTime? _lastLinkAt;
  static const _apns = MethodChannel('nightflix/apns-links');

  Future<void> start() async {
    if (controller.repository.demoMode) return;
    WidgetsBinding.instance.addObserver(this);
    controller.addListener(_accountChanged);
    if (Platform.isIOS) {
      _apns.setMethodCallHandler((call) async {
        if (call.method == 'open' && call.arguments is String) {
          final uri = Uri.tryParse(call.arguments as String);
          if (uri != null) _link(uri);
        }
      });
      try {
        final value = await _apns.invokeMethod<String>('initial');
        if (value != null) {
          final uri = Uri.tryParse(value);
          if (uri != null) _link(uri);
        }
      } catch (_) {
        /* Older internal packages have no APNs link channel. */
      }
    }
    try {
      final links = AppLinks();
      _subscriptions.add(
        links.uriLinkStream.listen(_link, onError: (Object _) {}),
      );
      final initial = await links.getInitialLink();
      if (initial != null && !_disposed) _link(initial);
    } catch (_) {
      /* Missing native link support never blocks ordinary navigation. */
    }
    try {
      _firebaseReady = await initializeTenantFirebase();
      if (!_firebaseReady || _disposed) return;
      FirebaseMessaging.onBackgroundMessage(tenantPushBackground);
      _subscriptions.add(FirebaseMessaging.onMessageOpenedApp.listen(_message));
      _subscriptions.add(
        FirebaseMessaging.instance.onTokenRefresh.listen((_) {
          _registeredKey = null;
          _accountChanged();
        }),
      );
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      if (initial != null && !_disposed) _message(initial);
      _accountChanged();
    } catch (_) {
      _firebaseReady = false;
    }
  }

  void _link(Uri uri) {
    if (_disposed) return;
    final id = linkedDramaId(uri, controller.config.deepLinkHost);
    if (id == null) return;
    final now = DateTime.now();
    if (_lastLink == id &&
        _lastLinkAt != null &&
        now.difference(_lastLinkAt!) < const Duration(seconds: 2)) {
      return;
    }
    _lastLink = id;
    _lastLinkAt = now;
    openDrama(id);
  }

  void _message(RemoteMessage message) {
    final link = message.data['deepLink'];
    if (link is String) {
      final uri = Uri.tryParse(link);
      if (uri != null) _link(uri);
    }
  }

  void _accountChanged() {
    if (_firebaseReady && !_disposed) unawaited(_register());
  }

  Future<void> _register() async {
    if (_registering) return;
    final session = controller.session;
    if (session == null || session.deviceId == null) {
      _registeredKey = null;
      return;
    }
    final scope = controller.accountScope;
    if (_registeredKey == '$scope:${session.deviceId}') return;
    _registering = true;
    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      if (settings.authorizationStatus != AuthorizationStatus.authorized &&
          settings.authorizationStatus != AuthorizationStatus.provisional) {
        return;
      }
      final token = Platform.isIOS
          ? await FirebaseMessaging.instance.getAPNSToken()
          : await FirebaseMessaging.instance.getToken();
      if (token == null || _disposed || controller.accountScope != scope) {
        return;
      }
      await controller.repository.registerPushToken(
        token,
        session.deviceId!,
        session.accessToken,
      );
      if (!_disposed && controller.accountScope == scope) {
        _registeredKey = '$scope:${session.deviceId}';
      }
    } catch (_) {
      /* Retry at next foreground/valid session event; do not block login. */
    } finally {
      _registering = false;
      if (!_disposed && controller.accountScope != scope) _accountChanged();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _accountChanged();
  }

  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(_accountChanged);
    if (Platform.isIOS) _apns.setMethodCallHandler(null);
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
  }
}
