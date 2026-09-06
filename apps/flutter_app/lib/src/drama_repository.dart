import 'dart:convert';
import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'models.dart';
import 'native_identity.dart';

class DramaRepository {
  DramaRepository({
    required String apiBaseUrl,
    FlutterSecureStorage? secureStorage,
  }) : apiBaseUrl = apiBaseUrl.replaceAll(RegExp(r'/$'), ''),
       _secureStorage = secureStorage ?? const FlutterSecureStorage();

  final String apiBaseUrl;
  final FlutterSecureStorage _secureStorage;
  UserSession? session;
  Future<void> Function(UserSession?)? onSessionChanged;
  Future<UserSession?>? _refreshing;
  Future<void> _sessionPersistence = Future.value();
  int _authEpoch = 0;
  final Set<String> _activeTokens = {};
  String get _sessionKey => 'nightflix:$apiBaseUrl:session:v1';
  String get _deviceKey => 'nightflix:$apiBaseUrl:device:v1';
  final Set<String> _demoUnlockedEpisodes = {};
  bool get demoMode => apiBaseUrl.isEmpty;

  Future<AppRuntimeConfig> bootstrap() async => demoMode
      ? AppRuntimeConfig.demo
      : AppRuntimeConfig.fromJson(await _get('/api/v1/customer/bootstrap'));

  Future<List<Drama>> dramas({String locale = 'en-US', String? query}) async {
    if (demoMode) return _demoDramasForLocale(locale);
    final parameters = <String, String>{'locale': locale, 'pageSize': '50'};
    if (query?.trim().isNotEmpty == true) parameters['q'] = query!.trim();
    return _catalogPages(parameters);
  }

  // Feed, theater and search consume a complete catalog, not just its first page.
  Future<List<Drama>> _catalogPages(Map<String, String> parameters) async {
    final items = <String, Drama>{};
    for (var page = 1; ; page++) {
      final uri = Uri.parse('$apiBaseUrl/api/v1/customer/content/dramas')
          .replace(queryParameters: {...parameters, 'page': '$page'});
      final body = await _request(uri);
      final batch = body['items'] as List? ?? const [];
      if (batch.isEmpty) break;
      final before = items.length;
      for (final value in batch) {
        final drama = Drama.fromJson(
          Map<String, dynamic>.from(value as Map),
          palette: items.length,
        );
        items.putIfAbsent(drama.id, () => drama);
      }
      if (items.length == before) {
        throw const ApiException('Catalog pagination did not advance', 502);
      }
      final total = body['total'] as num?;
      if (total != null ? page * 50 >= total : batch.length < 50) break;
    }
    return items.values.toList();
  }

  Future<Drama> detail(Drama drama, String locale) async {
    if (demoMode) return drama;
    final uri = Uri.parse(
      '$apiBaseUrl/api/v1/customer/content/dramas/${drama.id}',
    ).replace(queryParameters: {'locale': locale});
    return Drama.fromJson(
      await _request(uri, accessToken: session?.accessToken),
      palette: drama.palette,
    );
  }

  Future<Map<String, String>> categories(String locale) async {
    if (demoMode) {
      return {
        'romance': 'Romance',
        'revenge': 'Revenge',
        'billionaire': 'Billionaire',
        'fantasy': 'Fantasy',
      };
    }
    final json = await _get(
      '/api/v1/customer/categories?locale=${Uri.encodeComponent(locale)}',
    );
    return {
      for (final item in json['items'] as List? ?? [])
        item['code'] as String: item['name'] as String,
    };
  }

  Future<List<Drama>> categoryDramas(String category, String locale) async {
    if (demoMode) {
      const mapping = {
        'romance': ['demo-1'],
        'revenge': ['demo-2'],
        'billionaire': ['demo-3'],
      };
      return _demoDramasForLocale(locale)
          .where((d) => (mapping[category] ?? []).contains(d.id))
          .toList();
    }
    return _catalogPages({
      'locale': locale,
      'category': category,
      'pageSize': '50',
    });
  }

  Future<List<PlaybackProgress>> watchHistory(String token) async {
    if (demoMode) return [];
    final json = await _get(
      '/api/v1/customer/playback/history?page=1&pageSize=100',
      accessToken: token,
    );
    return (json['items'] as List? ?? [])
        .map(
          (item) =>
              PlaybackProgress.fromJson(Map<String, dynamic>.from(item as Map)),
        )
        .toList();
  }

  Future<List<String>> savedDramas(String token) async {
    if (demoMode) return [];
    final json = await _get(
      '/api/v1/customer/playback/favorites?page=1&pageSize=100',
      accessToken: token,
    );
    return (json['items'] as List? ?? [])
        .map((item) => item['dramaId'] as String)
        .toList();
  }

  Future<void> saveProgress(PlaybackProgress progress, String token) async {
    if (demoMode) return;
    await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/playback/progress'),
      method: 'PUT',
      payload: {
        'dramaId': progress.dramaId,
        'episodeId': progress.episodeId,
        'positionSeconds': progress.positionSeconds,
        'completed': progress.completed,
      },
      accessToken: token,
    );
  }

  Future<String?> assetUrl(String mediaId) async {
    if (demoMode) return null;
    return (await _get('/api/v1/customer/assets/$mediaId/url'))['url']
        as String?;
  }

  Future<Episode> playback(Episode episode, String accessToken) async {
    if (demoMode) {
      if (!episode.locked || _demoUnlockedEpisodes.contains(episode.id)) {
        final url = episode.playbackUrl ?? _demoPlaybackUrls[episode.id];
        return episode.withPlayback({'url': url, 'access': 'full'});
      }
      return episode;
    }
    try {
      final json = await _get(
        '/api/v1/customer/playback/episodes/${episode.id}/url',
        accessToken: accessToken.isEmpty ? null : accessToken,
      );
      return episode.withPlayback(json);
    } on ApiException catch (error) {
      if (error.statusCode == 403 &&
          (error.data['access'] == 'locked' ||
              error.data['code'] == 'PREVIEW_PLAYBACK_ASSET_UNAVAILABLE')) {
        return episode.withPlayback({'access': 'locked'});
      }
      rethrow;
    }
  }

  Future<SignedTrack> playbackTrack(
    Episode episode,
    EpisodeTrack track,
    String accessToken,
  ) async {
    if (demoMode) return SignedTrack(id: track.id, type: track.type, url: '');
    return SignedTrack.fromJson(
      await _get(
        '/api/v1/customer/playback/episodes/${episode.id}/tracks/${track.id}/url',
        accessToken: accessToken.isEmpty ? null : accessToken,
      ),
    );
  }

  Future<String> downloadTrackText(String signedUrl) async {
    final response = await http
        .get(Uri.parse(signedUrl))
        .timeout(const Duration(seconds: 15));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException('Subtitle download failed', response.statusCode);
    }
    if (response.bodyBytes.length > 5 * 1024 * 1024) {
      throw const ApiException('Subtitle file is too large', 413);
    }
    return utf8.decode(response.bodyBytes);
  }

  Future<DramaInteractionSummary> interactionSummary(
    String dramaId,
    String accessToken,
  ) async {
    if (demoMode) {
      return const DramaInteractionSummary(
        commentCount: 0,
        favoriteCount: 0,
        isFavorite: false,
        isLiked: false,
        likeCount: 0,
      );
    }
    return DramaInteractionSummary.fromJson(
      await _get(
        '/api/v1/customer/interactions/dramas/$dramaId/summary',
        accessToken: accessToken,
      ),
    );
  }

  Future<DramaInteractionSummary> setLike(
    String dramaId,
    String accessToken,
    bool liked,
  ) async => DramaInteractionSummary.fromJson(
    await _request(
      Uri.parse(
        '$apiBaseUrl/api/v1/customer/interactions/dramas/$dramaId/like',
      ),
      method: liked ? 'POST' : 'DELETE',
      accessToken: accessToken,
    ),
  );

  Future<void> setFavorite(
    String dramaId,
    String accessToken,
    bool favorite,
  ) async {
    if (demoMode) return;
    await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/playback/favorites/$dramaId'),
      method: favorite ? 'POST' : 'DELETE',
      accessToken: accessToken,
    );
  }

  Future<List<DramaComment>> comments(
    String dramaId,
    String accessToken,
  ) async {
    if (demoMode) return const [];
    final uri = Uri.parse('$apiBaseUrl/api/v1/customer/interactions/comments')
        .replace(queryParameters: {'dramaId': dramaId, 'pageSize': '50'});
    final json = await _request(uri, accessToken: accessToken);
    return (json['items'] as List? ?? const [])
        .map(
          (item) =>
              DramaComment.fromJson(Map<String, dynamic>.from(item as Map)),
        )
        .toList();
  }

  Future<DramaComment> createComment(
    String dramaId,
    String body,
    String accessToken,
  ) async {
    if (demoMode) {
      return DramaComment(
        id: 'demo-${DateTime.now().microsecondsSinceEpoch}',
        body: body,
        createdAt: DateTime.now(),
        username: 'Demo viewer',
      );
    }
    final json = await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/interactions/comments'),
      method: 'POST',
      payload: {'dramaId': dramaId, 'body': body},
      accessToken: accessToken,
      extraHeaders: {
        'Idempotency-Key': 'comment-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
    return DramaComment.fromJson(json);
  }

  Future<RewardedUnlockChallenge> createRewardedChallenge(
    String episodeId,
    String accessToken,
  ) async {
    if (demoMode) {
      return RewardedUnlockChallenge(
        adUnitId: Platform.isIOS
            ? 'ca-app-pub-3940256099942544/1712485313'
            : 'ca-app-pub-3940256099942544/5224354917',
        alreadyUnlocked: false,
        challengeId: 'demo:$episodeId',
        status: 'pending',
      );
    }
    return RewardedUnlockChallenge.fromJson(
      await _request(
        Uri.parse(
          '$apiBaseUrl/api/v1/customer/rewarded-unlocks/episodes/$episodeId/challenges',
        ),
        method: 'POST',
        payload: {
          'platform': Platform.isIOS ? 'ios' : 'android',
          'placementKey': 'episode_unlock',
        },
        accessToken: accessToken,
      ),
    );
  }

  Future<void> unlockWithPoints(
    String targetType,
    String targetId,
    String accessToken,
  ) async {
    if (demoMode) {
      if (targetType == 'episode') _demoUnlockedEpisodes.add(targetId);
      return;
    }
    await _request(
      Uri.parse(
        '$apiBaseUrl/api/v1/customer/commerce/point-unlocks/$targetType/$targetId',
      ),
      method: 'POST',
      payload: const {},
      accessToken: accessToken,
      extraHeaders: {'Idempotency-Key': 'point-unlock-$targetType-$targetId'},
    );
  }

  Future<PointWallet> wallet(String accessToken) async => demoMode
      ? const PointWallet(balancePoints: '0')
      : PointWallet.fromJson(
          await _get(
            '/api/v1/customer/wallet/points',
            accessToken: accessToken,
          ),
        );

  Future<List<InboxMessage>> inbox(String accessToken) async {
    if (demoMode) return const [];
    final json = await _get(
      '/api/v1/customer/notifications/inbox?page=1&pageSize=50',
      accessToken: accessToken,
    );
    return (json['items'] as List? ?? const [])
        .map(
          (value) =>
              InboxMessage.fromJson(Map<String, dynamic>.from(value as Map)),
        )
        .toList();
  }

  Future<void> markMessageRead(String messageId, String accessToken) async {
    if (demoMode) return;
    await _request(
      Uri.parse(
        '$apiBaseUrl/api/v1/customer/notifications/inbox/$messageId/read',
      ),
      method: 'POST',
      accessToken: accessToken,
    );
  }

  Future<String> rewardedStatus(String challengeId, String accessToken) async {
    if (demoMode && challengeId.startsWith('demo:')) {
      _demoUnlockedEpisodes.add(challengeId.substring('demo:'.length));
      return 'granted';
    }
    return (await _get(
              '/api/v1/customer/rewarded-unlocks/$challengeId',
              accessToken: accessToken,
            ))['status']
            as String? ??
        'pending';
  }

  Future<void> registerPushToken(
    String token,
    String deviceId,
    String accessToken,
  ) async {
    await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/notifications/push-tokens'),
      method: 'POST',
      accessToken: accessToken,
      payload: {
        'token': token,
        'deviceId': deviceId,
        'platform': Platform.isIOS ? 'ios' : 'android',
      },
    );
  }

  Future<void> adObservation(Map<String, dynamic> observation) async {
    if (demoMode) return;
    await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/ads/observations'),
      method: 'POST',
      payload: observation,
    );
  }

  Future<String> nativePurchaseBinding(
    String accessToken, {
    String? store,
    String? productId,
  }) async =>
      (await _request(
            Uri.parse('$apiBaseUrl/api/v1/customer/native-store/prepare'),
            method: 'POST',
            accessToken: accessToken,
            payload: store == null
                ? null
                : {'store': store, 'productId': productId},
          ))['accountBinding']
          as String;

  Future<String> confirmNativePurchase(
    String store,
    String productId,
    String receipt,
    String accessToken,
  ) async {
    final result = await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/native-store/verify'),
      method: 'POST',
      accessToken: accessToken,
      payload: {'store': store, 'productId': productId, 'receipt': receipt},
    );
    return result['status'] as String;
  }

  Future<void> identityLogin(
    String provider,
    AppRuntimeConfig config,
    String locale,
    List<Map<String, dynamic>> consents,
  ) async {
    final epoch = ++_authEpoch;
    _activeTokens.clear();
    final challenge = await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/auth/identity/challenge'),
      method: 'POST',
      payload: {'provider': provider},
    );
    final identityToken = await nativeIdentityToken(
      provider,
      challenge['nonce'] as String,
      config.identity,
    );
    if (epoch != _authEpoch) {
      throw const ApiException('Login was cancelled', 401);
    }
    final device = await _secureStorage.read(key: _deviceKey);
    final json = await _request(
      Uri.parse('$apiBaseUrl/api/v1/customer/auth/identity/login'),
      method: 'POST',
      payload: {
        'provider': provider,
        'challengeId': challenge['challengeId'],
        'identityToken': identityToken,
        'devicePlatform': Platform.isIOS ? 'ios' : 'android',
        'deviceLabel': 'Night Flix',
        'deviceToken': ?device,
        'legalLocale': locale,
        'legalConsents': consents,
      },
    );
    if (epoch != _authEpoch) {
      throw const ApiException('Login was cancelled', 401);
    }
    await _setSession(UserSession.fromJson(json));
  }

  Future<UserSession> login(String email, String password) async {
    final epoch = ++_authEpoch;
    _activeTokens.clear();
    if (demoMode) {
      final value = UserSession(
        accessToken: 'demo',
        refreshToken: 'demo',
        email: email,
        accountId: email.trim().toLowerCase(),
      );
      await _setSession(value);
      return value;
    }
    final device = await _secureStorage.read(key: _deviceKey);
    final json = await _post('/api/v1/customer/auth/login', {
      'deviceLabel': 'Night Flix App',
      'devicePlatform': Platform.isIOS ? 'ios' : 'android',
      'identifier': email.trim(),
      'password': password,
      'deviceToken': ?device,
    });
    if (epoch != _authEpoch) throw const ApiException('Session changed', 401);
    final value = UserSession.fromJson(json, email: email.trim());
    await _setSession(value);
    return value;
  }

  Future<void> restoreSession() async {
    if (demoMode) return;
    final raw = await _secureStorage.read(key: _sessionKey);
    if (raw == null) return;
    try {
      session = UserSession.fromJson(
        Map<String, dynamic>.from(jsonDecode(raw) as Map),
      );
      _activeTokens.add(session!.accessToken);
      await onSessionChanged?.call(session);
    } on FormatException {
      await _setSession(null);
    } on TypeError {
      await _setSession(null);
    }
  }

  Future<void> _setSession(UserSession? value) async {
    session = value;
    if (value != null) _activeTokens.add(value.accessToken);
    if (value == null) _activeTokens.clear();
    final changed = onSessionChanged?.call(value);
    final write = _sessionPersistence.catchError((Object _) {}).then((_) async {
      if (demoMode) return;
      if (value == null) {
        await _secureStorage.delete(key: _sessionKey);
      } else {
        await _secureStorage.write(
          key: _sessionKey,
          value: jsonEncode(value.toJson()),
        );
        if (value.deviceToken != null) {
          await _secureStorage.write(key: _deviceKey, value: value.deviceToken);
        }
      }
    });
    _sessionPersistence = write;
    await changed;
    await write;
  }

  Future<List<Map<String, dynamic>>> legalDocuments(String locale) async {
    if (demoMode) return [];
    final json = await _get(
      '/api/v1/customer/legal/documents/current?locale=${Uri.encodeComponent(locale)}',
    );
    return (json['documents'] as List? ?? [])
        .map((item) => Map<String, dynamic>.from(item as Map))
        .toList();
  }

  Future<String> requestEmailCode(String email, String purpose) async {
    final json = await _post('/api/v1/customer/auth/otp/challenges', {
      'channel': 'email',
      'destination': email.trim(),
      'purpose': purpose,
    });
    return json['challengeId'] as String;
  }

  Future<String> verifyEmailCode(
    String email,
    String purpose,
    String challengeId,
    String code,
  ) async {
    final json = await _post('/api/v1/customer/auth/otp/verify', {
      'channel': 'email',
      'destination': email.trim(),
      'purpose': purpose,
      'challengeId': challengeId,
      'code': code.trim(),
    });
    return json['verificationToken'] as String;
  }

  Future<void> registerEmail({
    required String email,
    required String username,
    required String password,
    required String verificationToken,
    required String locale,
    required List<Map<String, dynamic>> consents,
  }) async {
    await _post('/api/v1/customer/auth/register', {
      'username': username.trim(),
      'email': email.trim(),
      'password': password,
      'emailVerificationToken': verificationToken,
      'legalLocale': locale,
      'legalConsents': consents,
    });
  }

  Future<void> resetPassword(
    String email,
    String password,
    String verificationToken,
  ) async {
    await _post('/api/v1/customer/auth/password/reset', {
      'channel': 'email',
      'destination': email.trim(),
      'newPassword': password,
      'verificationToken': verificationToken,
    });
  }

  Future<void> logout() async {
    final previous = session;
    final refresh = _refreshing;
    ++_authEpoch;
    // Remove local credentials immediately; a late refresh may never resurrect them.
    await _setSession(null);
    if (demoMode || previous == null) return;
    UserSession? rotated;
    try {
      rotated = await refresh;
    } catch (_) {
      /* Revoke the last known token below. */
    }
    await _post('/api/v1/customer/auth/logout', {
      'refreshToken': rotated?.refreshToken ?? previous.refreshToken,
    });
  }

  Future<UserSession?> _refreshSession() async {
    final pending = _refreshing;
    if (pending != null) return pending;
    final previous = session;
    if (previous == null) return null;
    final epoch = _authEpoch;
    final work = () async {
      try {
        final json = await _post('/api/v1/customer/auth/refresh', {
          'refreshToken': previous.refreshToken,
        });
        final value = UserSession.fromJson(json, email: previous.email);
        if (epoch == _authEpoch) await _setSession(value);
        return value;
      } on ApiException catch (error) {
        if ((error.statusCode == 401 || error.statusCode == 403) &&
            epoch == _authEpoch) {
          ++_authEpoch;
          await _setSession(null);
        }
        rethrow;
      }
    }();
    _refreshing = work;
    try {
      return await work;
    } finally {
      if (identical(_refreshing, work)) _refreshing = null;
    }
  }

  Future<Map<String, dynamic>> _get(String path, {String? accessToken}) =>
      _request(Uri.parse('$apiBaseUrl$path'), accessToken: accessToken);

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> payload,
  ) =>
      _request(Uri.parse('$apiBaseUrl$path'), method: 'POST', payload: payload);

  Future<Map<String, dynamic>> _request(
    Uri uri, {
    String method = 'GET',
    Map<String, dynamic>? payload,
    String? accessToken,
    Map<String, String>? extraHeaders,
    bool retryAuthentication = true,
  }) async {
    final epoch = _authEpoch;
    final current = session;
    if (accessToken != null && current == null) {
      throw const ApiException('Please sign in again', 401);
    }
    if (accessToken != null && current != null) {
      if (accessToken != current.accessToken &&
          !_activeTokens.contains(accessToken)) {
        throw const ApiException('Session changed', 401);
      }
      accessToken = current.accessToken;
    }
    final headers = <String, String>{'Accept': 'application/json'};
    if (extraHeaders != null) headers.addAll(extraHeaders);
    if (payload != null) headers['Content-Type'] = 'application/json';
    if (accessToken != null) headers['Authorization'] = 'Bearer $accessToken';
    final request = http.Request(method, uri);
    request.headers.addAll(headers);
    if (payload != null) request.body = jsonEncode(payload);
    final streamed = await request.send().timeout(const Duration(seconds: 15));
    final resolved = await http.Response.fromStream(streamed)
        .timeout(const Duration(seconds: 15));
    if (accessToken != null && epoch != _authEpoch) {
      throw const ApiException('Session changed', 401);
    }
    if (resolved.statusCode == 401 &&
        accessToken != null &&
        current != null &&
        retryAuthentication) {
      if (session?.accessToken == accessToken) await _refreshSession();
      if (epoch != _authEpoch || session == null) {
        throw const ApiException('Please sign in again', 401);
      }
      return _request(
        uri,
        method: method,
        payload: payload,
        accessToken: session!.accessToken,
        extraHeaders: extraHeaders,
        retryAuthentication: false,
      );
    }
    Map<String, dynamic> decoded;
    try {
      decoded = resolved.body.isEmpty
          ? <String, dynamic>{}
          : Map<String, dynamic>.from(jsonDecode(resolved.body) as Map);
    } catch (_) {
      throw ApiException(
        'Invalid server response',
        resolved.statusCode >= 400 ? resolved.statusCode : 502,
      );
    }
    if (resolved.statusCode < 200 || resolved.statusCode >= 300) {
      throw ApiException(
        decoded['message']?.toString() ?? 'Request failed',
        resolved.statusCode,
        decoded,
      );
    }
    return decoded;
  }
}

class ApiException implements Exception {
  const ApiException(this.message, this.statusCode, [this.data = const {}]);
  final String message;
  final int statusCode;
  final Map<String, dynamic> data;
  @override
  String toString() => message;
}

class AppController extends ChangeNotifier {
  AppController(this.repository) {
    repository.onSessionChanged = (_) async {
      if (_loadedScope != _scope) {
        await _loadLocalState();
        unawaited(_syncAccountData());
      }
      notifyListeners();
    };
  }
  final DramaRepository repository;

  AppRuntimeConfig config = AppRuntimeConfig.demo;
  List<Drama> dramas = const [];
  UserSession? get session => repository.session;
  set session(UserSession? value) => repository.session = value;
  String locale = 'en-US';
  bool loading = true;
  String? error;
  final Set<String> favorites = {};
  final Set<String> following = {};
  final List<String> history = [];
  final Map<String, DramaInteractionSummary> interactions = {};
  final Map<String, String?> assetUrls = {};
  final Map<String, DateTime> _assetExpiry = {};
  final Map<String, PlaybackProgress> progress = {};
  final Map<String, Drama> libraryDramas = {};
  final Map<String, PlaybackProgress> _pendingProgress = {};
  bool _savingProgress = false;
  bool _disposed = false;
  int _localeRevision = 0;

  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    repository.onSessionChanged = null;
    super.dispose();
  }

  Future<void> recordProgress(PlaybackProgress value) async {
    final scope = _scope;
    progress[value.dramaId] = value;
    if (session != null) _pendingProgress[value.episodeId] = value;
    await _persistProgress(scope);
    if (scope == _scope) await _flushProgress();
  }

  Future<void> _persistProgress(String scope) async {
    if (scope != _scope) return;
    final saved = jsonEncode({
      'items': progress.values.map((p) => p.toJson()).toList(),
      'pending': _pendingProgress.values.map((p) => p.toJson()).toList(),
    });
    await (await SharedPreferences.getInstance()).setString(
      '$scope:progress',
      saved,
    );
  }

  Future<void> _flushProgress() async {
    if (_savingProgress || session == null) return;
    final scope = _scope;
    final token = session!.accessToken;
    _savingProgress = true;
    try {
      for (final item in _pendingProgress.values.toList()) {
        if (scope != _scope) return;
        await repository.saveProgress(item, token);
        if (scope != _scope) return;
        if (identical(_pendingProgress[item.episodeId], item)) {
          _pendingProgress.remove(item.episodeId);
        }
      }
      await _persistProgress(scope);
    } catch (_) {
      // Keep the account-scoped queue for the next progress update or app restart.
    } finally {
      _savingProgress = false;
    }
  }

  Future<void> _syncAccountData() async {
    final user = session;
    if (user == null || repository.demoMode) return;
    final scope = _scope;
    try {
      final watched = await repository.watchHistory(user.accessToken);
      final saved = await repository.savedDramas(user.accessToken);
      if (scope != _scope) return;
      favorites
        ..clear()
        ..addAll(saved);
      for (final item in watched.reversed) {
        final local = progress[item.dramaId];
        if (local == null || !local.updatedAt.isAfter(item.updatedAt)) {
          progress[item.dramaId] = item;
        }
      }
      final recent = progress.values.toList()
        ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
      history
        ..clear()
        ..addAll(recent.take(100).map((p) => p.dramaId));
      for (final id in {...saved, ...history}.take(100)) {
        if (scope != _scope) return;
        try {
          final drama = await repository.detail(
            Drama(id: id, title: '', summary: '', totalEpisodes: 0),
            locale,
          );
          if (scope != _scope) return;
          libraryDramas[id] = drama;
        } on ApiException catch (error) {
          if (scope != _scope) return;
          if (error.statusCode == 403 || error.statusCode == 404) {
            libraryDramas.remove(id);
          }
        }
      }
      final preferences = await SharedPreferences.getInstance();
      if (scope != _scope) return;
      final savedFavorites = favorites.toList();
      final savedHistory = history.toList();
      await preferences.setStringList('$scope:favorites', savedFavorites);
      await preferences.setStringList('$scope:history', savedHistory);
      if (scope != _scope) return;
      await _persistProgress(scope);
      await _flushProgress();
      if (scope == _scope) notifyListeners();
    } catch (_) {
      /* Cached account data remains available during outages. */
    }
  }

  String? _loadedScope;
  String get accountScope => _scope;
  String get _scope =>
      '${repository.apiBaseUrl}:v2:${session?.accountId.isNotEmpty == true ? session!.accountId : session?.email ?? 'guest'}';
  String get _localeKey => '${repository.apiBaseUrl}:locale';

  Future<void> _loadLocalState() async {
    final scope = _scope;
    _loadedScope = scope;
    favorites.clear();
    following.clear();
    history.clear();
    interactions.clear();
    progress.clear();
    libraryDramas.clear();
    _pendingProgress.clear();
    notifyListeners();
    final preferences = await SharedPreferences.getInstance();
    if (_scope != scope) return;
    favorites.addAll(preferences.getStringList('$scope:favorites') ?? const []);
    following.addAll(preferences.getStringList('$scope:following') ?? const []);
    history.addAll(preferences.getStringList('$scope:history') ?? const []);
    final raw = preferences.getString('$scope:progress');
    if (raw != null) {
      try {
        final json = jsonDecode(raw) as Map;
        for (final item in json['items'] as List? ?? []) {
          final p = PlaybackProgress.fromJson(
            Map<String, dynamic>.from(item as Map),
          );
          progress[p.dramaId] = p;
        }
        for (final item in json['pending'] as List? ?? []) {
          final p = PlaybackProgress.fromJson(
            Map<String, dynamic>.from(item as Map),
          );
          _pendingProgress[p.episodeId] = p;
        }
      } catch (_) {
        progress.clear();
        _pendingProgress.clear();
      }
    }
  }

  Future<void> initialize() async {
    error = null;
    try {
      config = await repository.bootstrap();
      await repository.restoreSession();
      final preferences = await SharedPreferences.getInstance();
      locale = preferences.getString(_localeKey) ?? config.defaultLocale;
      if (!config.supportedLocales.contains(locale)) {
        locale = config.defaultLocale;
      }
      await _loadLocalState();
      try {
        dramas = await repository.dramas(locale: locale);
      } on ApiException catch (failure) {
        if (failure.statusCode != 400 || locale == config.defaultLocale) {
          rethrow;
        }
        locale = config.defaultLocale;
        dramas = await repository.dramas(locale: locale);
      }
      await preferences.setString(_localeKey, locale);
      unawaited(_syncAccountData());
    } catch (cause) {
      error = cause.toString();
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> retry() async {
    loading = true;
    error = null;
    notifyListeners();
    await initialize();
  }

  Future<void> setLocale(String value) async {
    if (!config.supportedLocales.contains(value)) return;
    final revision = ++_localeRevision;
    final loaded = await repository.dramas(locale: value);
    if (revision != _localeRevision) return;
    locale = value;
    dramas = loaded;
    await (await SharedPreferences.getInstance()).setString(_localeKey, value);
    notifyListeners();
  }

  Future<void> search(String query) async {
    loading = true;
    notifyListeners();
    try {
      dramas = await repository.dramas(locale: locale, query: query);
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<Drama> loadDetail(Drama drama) => repository.detail(drama, locale);

  Future<String?> assetUrl(String mediaId) async {
    if ((_assetExpiry[mediaId]?.isAfter(DateTime.now()) ?? false)) {
      return assetUrls[mediaId];
    }
    final value = await repository.assetUrl(mediaId);
    assetUrls[mediaId] = value;
    _assetExpiry[mediaId] = DateTime.now().add(const Duration(seconds: 120));
    return value;
  }

  Future<SignedTrack> loadPlaybackTrack(Episode episode, EpisodeTrack track) {
    return repository.playbackTrack(episode, track, session?.accessToken ?? '');
  }

  Future<Episode> loadPlayback(Episode episode) async {
    return repository.playback(episode, session?.accessToken ?? '');
  }

  Future<DramaInteractionSummary> loadInteractions(String dramaId) async {
    if (session == null) {
      return interactions[dramaId] ??
          const DramaInteractionSummary(
            commentCount: 0,
            favoriteCount: 0,
            isFavorite: false,
            isLiked: false,
            likeCount: 0,
          );
    }
    final scope = _scope;
    final summary = await repository.interactionSummary(
      dramaId,
      session!.accessToken,
    );
    if (scope != _scope) return summary;
    interactions[dramaId] = summary;
    if (summary.isFavorite) favorites.add(dramaId);
    if (!summary.isFavorite) favorites.remove(dramaId);
    notifyListeners();
    return summary;
  }

  Future<void> toggleLike(String dramaId) async {
    final scope = _scope;
    final current = interactions[dramaId];
    final nextLiked = !(current?.isLiked ?? false);
    if (session == null) throw const ApiException('Sign in to like', 401);
    final summary = repository.demoMode
        ? (current ??
                  const DramaInteractionSummary(
                    commentCount: 0,
                    favoriteCount: 0,
                    isFavorite: false,
                    isLiked: false,
                    likeCount: 0,
                  ))
              .copyWith(isLiked: nextLiked)
        : await repository.setLike(dramaId, session!.accessToken, nextLiked);
    if (scope != _scope) return;
    interactions[dramaId] = summary;
    notifyListeners();
  }

  Future<void> login(String email, String password) async {
    await repository.login(email, password);
  }

  Future<void> logout() => repository.logout();

  Future<void> toggleFavorite(String dramaId) async {
    if (session == null) throw const ApiException('Sign in to save', 401);
    final scope = _scope;
    final favorite = !favorites.contains(dramaId);
    if (session != null) {
      await repository.setFavorite(dramaId, session!.accessToken, favorite);
    }
    if (_scope != scope) return;
    favorite ? favorites.add(dramaId) : favorites.remove(dramaId);
    final saved = favorites.toList();
    await (await SharedPreferences.getInstance()).setStringList(
      '$scope:favorites',
      saved,
    );
    notifyListeners();
  }

  Future<void> toggleFollowing(String dramaId) async {
    final scope = _scope;
    following.contains(dramaId)
        ? following.remove(dramaId)
        : following.add(dramaId);
    final saved = following.toList();
    await (await SharedPreferences.getInstance()).setStringList(
      '$scope:following',
      saved,
    );
    notifyListeners();
  }

  Future<List<DramaComment>> comments(String dramaId) {
    if (session == null) throw const ApiException('Sign in to comment', 401);
    return repository.comments(dramaId, session!.accessToken);
  }

  Future<DramaComment> createComment(String dramaId, String body) {
    if (session == null) throw const ApiException('Sign in to comment', 401);
    return repository.createComment(dramaId, body, session!.accessToken);
  }

  Future<RewardedUnlockChallenge> createRewardedChallenge(String episodeId) {
    if (session == null) throw const ApiException('Sign in to unlock', 401);
    return repository.createRewardedChallenge(episodeId, session!.accessToken);
  }

  Future<void> unlockWithPoints(String targetType, String targetId) {
    if (session == null) throw const ApiException('Sign in to unlock', 401);
    return repository.unlockWithPoints(
      targetType,
      targetId,
      session!.accessToken,
    );
  }

  Future<PointWallet> wallet() {
    if (session == null) {
      throw const ApiException('Sign in to view your balance', 401);
    }
    return repository.wallet(session!.accessToken);
  }

  Future<List<InboxMessage>> inbox() {
    if (session == null) {
      throw const ApiException('Sign in to view messages', 401);
    }
    return repository.inbox(session!.accessToken);
  }

  Future<void> markMessageRead(String messageId) {
    if (session == null) {
      throw const ApiException('Sign in to view messages', 401);
    }
    return repository.markMessageRead(messageId, session!.accessToken);
  }

  Future<bool> waitForReward(String challengeId) async {
    if (session == null) return false;
    for (var attempt = 0; attempt < 8; attempt += 1) {
      final status = await repository.rewardedStatus(
        challengeId,
        session!.accessToken,
      );
      if (status == 'granted') return true;
      if (status == 'expired') return false;
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    return false;
  }

  Future<void> markWatched(String dramaId) async {
    final scope = _scope;
    history.remove(dramaId);
    history.insert(0, dramaId);
    if (history.length > 100) history.removeRange(100, history.length);
    final saved = history.toList();
    await (await SharedPreferences.getInstance()).setStringList(
      '$scope:history',
      saved,
    );
    notifyListeners();
  }
}

const _demoDramas = [
  Drama(
    id: 'demo-1',
    title: 'The Last Contract',
    totalEpisodes: 3,
    palette: 0,
    summary: 'She signed a marriage contract to save her family, then discovered the stranger was the heir everyone feared.',
    episodes: [
      Episode(
        id: 'demo-1-1',
        number: 1,
        title: 'The Agreement',
        durationSeconds: 8,
        previewSeconds: 8,
        playbackUrl: 'asset://assets/demo/contract.mp4',
      ),
      Episode(
        id: 'demo-1-2',
        number: 2,
        title: 'The Hidden Name',
        durationSeconds: 8,
        previewSeconds: 8,
        playbackUrl: 'asset://assets/demo/revenge.mp4',
      ),
      Episode(
        id: 'demo-1-3',
        number: 3,
        title: 'Terms Changed',
        durationSeconds: 8,
        previewSeconds: 8,
        playbackUrl: 'asset://assets/demo/secret-ceo.mp4',
      ),
    ],
  ),
  Drama(
    id: 'demo-2',
    title: 'Reborn for Revenge',
    totalEpisodes: 2,
    palette: 1,
    summary: 'A second chance turns betrayal into a carefully planned return.',
    episodes: [
      Episode(
        id: 'demo-2-1',
        number: 1,
        title: 'Back to That Night',
        durationSeconds: 8,
        previewSeconds: 8,
        playbackUrl: 'asset://assets/demo/revenge.mp4',
      ),
      Episode(
        id: 'demo-2-2',
        number: 2,
        title: 'The First Move',
        durationSeconds: 8,
        previewSeconds: 8,
        playbackUrl: 'asset://assets/demo/contract.mp4',
      ),
    ],
  ),
  Drama(
    id: 'demo-3',
    title: 'My Secret CEO',
    totalEpisodes: 3,
    palette: 2,
    summary: 'An ordinary first day at work becomes a secret neither of them can reveal.',
    episodes: [
      Episode(
        id: 'demo-3-1',
        number: 1,
        title: 'First Day',
        durationSeconds: 8,
        previewSeconds: 8,
        playbackUrl: 'asset://assets/demo/secret-ceo.mp4',
      ),
      Episode(
        id: 'demo-3-2',
        number: 2,
        title: 'Behind the Office Door',
        durationSeconds: 8,
        previewSeconds: 0,
        pointsAmount: 5,
        access: 'locked',
      ),
      Episode(
        id: 'demo-3-3',
        number: 3,
        title: 'The Secret Meeting',
        durationSeconds: 8,
        previewSeconds: 0,
        pointsAmount: 5,
        access: 'locked',
      ),
    ],
  ),
];

List<Drama> _demoDramasForLocale(String locale) {
  if (!locale.startsWith('zh')) return _demoDramas;
  const titles = {'demo-1': '最后的契约', 'demo-2': '重生复仇', 'demo-3': '我的秘密总裁'};
  const summaries = {
    'demo-1': '为了拯救家人，她签下了一份婚姻契约，却发现那个陌生人正是令所有人畏惧的继承人。',
    'demo-2': '命运重来一次，她将背叛变成了一场精心策划的归来。',
    'demo-3': '平凡的入职第一天，变成了两个人都不能说出的秘密。',
  };
  const episodeTitles = {
    'demo-1-1': '契约',
    'demo-1-2': '隐藏的名字',
    'demo-1-3': '条款改变',
    'demo-2-1': '回到那一夜',
    'demo-2-2': '第一步',
    'demo-3-1': '入职第一天',
    'demo-3-2': '办公室门后',
    'demo-3-3': '秘密会面',
  };
  return _demoDramas
      .map(
        (drama) => Drama(
          id: drama.id,
          title: titles[drama.id] ?? drama.title,
          summary: summaries[drama.id] ?? drama.summary,
          totalEpisodes: drama.totalEpisodes,
          coverMediaId: drama.coverMediaId,
          pointsAmount: drama.pointsAmount,
          palette: drama.palette,
          episodes: drama.episodes
              .map(
                (episode) => Episode(
                  id: episode.id,
                  number: episode.number,
                  title: episodeTitles[episode.id] ?? episode.title,
                  durationSeconds: episode.durationSeconds,
                  previewSeconds: episode.previewSeconds,
                  pointsAmount: episode.pointsAmount,
                  playbackUrl: episode.playbackUrl,
                  access: episode.access,
                  tracks: episode.tracks,
                ),
              )
              .toList(),
        ),
      )
      .toList();
}

const _demoPlaybackUrls = {
  'demo-3-2': 'asset://assets/demo/contract.mp4',
  'demo-3-3': 'asset://assets/demo/revenge.mp4',
};
