import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

Future<void>? _googleInitialization;
String? _googleClient;
Future<String> nativeIdentityToken(
  String provider,
  String nonce,
  Map<String, dynamic> config,
) async {
  if (provider == 'apple') {
    if (!Platform.isIOS) throw StateError('Apple native sign-in requires iOS');
    final credential = await SignInWithApple.getAppleIDCredential(
      scopes: [],
      nonce: sha256.convert(utf8.encode(nonce)).toString(),
    );
    final token = credential.identityToken;
    if (token == null) throw StateError('Identity token is missing');
    return token;
  }
  final clientId = config['googleClientId'] as String;
  if (_googleClient != null && _googleClient != clientId) {
    throw StateError('Tenant identity configuration changed');
  }
  _googleClient = clientId;
  _googleInitialization ??= GoogleSignIn.instance
      .initialize(
        serverClientId: clientId,
        clientId: config['googleIosClientId'] as String?,
      )
      .catchError((Object error) {
        _googleInitialization = null;
        throw error;
      });
  await _googleInitialization;
  final account = await GoogleSignIn.instance.authenticate();
  final token = account.authentication.idToken;
  if (token == null) throw StateError('Identity token is missing');
  return token;
}
