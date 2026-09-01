import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

class DramaRepository {
  DramaRepository({required String apiBaseUrl})
    : apiBaseUrl = apiBaseUrl.replaceAll(RegExp(r'/$'), '');

  final String apiBaseUrl;
  bool get demoMode => apiBaseUrl.isEmpty;

  Future<AppRuntimeConfig> bootstrap() async => demoMode
      ? AppRuntimeConfig.demo
      : AppRuntimeConfig.fromJson(await _get('/api/v1/customer/bootstrap'));

  Future<List<Drama>> dramas({String locale = 'en-US', String? query}) async {
    if (demoMode) return _demoDramas;
    final parameters = <String, String>{'locale': locale, 'pageSize': '50'};
    if (query?.trim().isNotEmpty == true) parameters['q'] = query!.trim();
    final uri = Uri.parse('$apiBaseUrl/api/v1/customer/content/dramas')
        .replace(queryParameters: parameters);
    final body = await _request(uri);
    return (body['items'] as List? ?? const []).indexed
        .map(
          (entry) => Drama.fromJson(
            Map<String, dynamic>.from(entry.$2 as Map),
            palette: entry.$1,
          ),
        )
        .toList();
  }

  Future<Drama> detail(Drama drama, String locale) async {
    if (demoMode) return drama;
    final uri = Uri.parse(
      '$apiBaseUrl/api/v1/customer/content/dramas/${drama.id}',
    ).replace(queryParameters: {'locale': locale});
    return Drama.fromJson(await _request(uri), palette: drama.palette);
  }

  Future<Episode> playback(Episode episode, String accessToken) async {
    if (demoMode) return episode;
    final json = await _get(
      '/api/v1/customer/playback/episodes/${episode.id}/url',
      accessToken: accessToken,
    );
    return episode.withPlayback(json);
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
      return const RewardedUnlockChallenge(
        alreadyUnlocked: true,
        status: 'granted',
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

  Future<String> rewardedStatus(String challengeId, String accessToken) async =>
      (await _get(
            '/api/v1/customer/rewarded-unlocks/$challengeId',
            accessToken: accessToken,
          ))['status']
          as String? ??
      'pending';

  Future<UserSession> login(String email, String password) async {
    if (demoMode) {
      return UserSession(
        accessToken: 'demo',
        refreshToken: 'demo',
        email: email,
      );
    }
    final json = await _post('/api/v1/customer/auth/login', {
      'deviceLabel': 'Shanchuang Drama App',
      'devicePlatform': Platform.isIOS ? 'ios' : 'android',
      'identifier': email.trim(),
      'password': password,
    });
    return UserSession(
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
      email: email.trim(),
    );
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
  }) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (extraHeaders != null) headers.addAll(extraHeaders);
    if (payload != null) headers['Content-Type'] = 'application/json';
    if (accessToken != null) headers['Authorization'] = 'Bearer $accessToken';
    final request = http.Request(method, uri);
    request.headers.addAll(headers);
    if (payload != null) request.body = jsonEncode(payload);
    final streamed = await request.send().timeout(const Duration(seconds: 15));
    final resolved = await http.Response.fromStream(streamed);
    final decoded = resolved.body.isEmpty
        ? <String, dynamic>{}
        : Map<String, dynamic>.from(jsonDecode(resolved.body) as Map);
    if (resolved.statusCode < 200 || resolved.statusCode >= 300) {
      throw ApiException(
        decoded['message']?.toString() ?? 'Request failed',
        resolved.statusCode,
      );
    }
    return decoded;
  }
}

class ApiException implements Exception {
  const ApiException(this.message, this.statusCode);
  final String message;
  final int statusCode;
  @override
  String toString() => message;
}

class AppController extends ChangeNotifier {
  AppController(this.repository);
  final DramaRepository repository;

  AppRuntimeConfig config = AppRuntimeConfig.demo;
  List<Drama> dramas = const [];
  UserSession? session;
  String locale = 'en-US';
  bool loading = true;
  String? error;
  final Set<String> favorites = {};
  final List<String> history = [];
  final Map<String, DramaInteractionSummary> interactions = {};

  Future<void> initialize() async {
    try {
      config = await repository.bootstrap();
      final preferences = await SharedPreferences.getInstance();
      locale = preferences.getString('locale') ?? config.defaultLocale;
      if (!config.supportedLocales.contains(locale)) {
        locale = config.defaultLocale;
      }
      favorites.addAll(preferences.getStringList('favorites') ?? const []);
      history.addAll(preferences.getStringList('history') ?? const []);
      dramas = await repository.dramas(locale: locale);
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
    locale = value;
    await (await SharedPreferences.getInstance()).setString('locale', value);
    dramas = await repository.dramas(locale: locale);
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

  Future<Episode> loadPlayback(Episode episode) async {
    if (session == null) {
      throw const ApiException('Sign in to continue watching', 401);
    }
    return repository.playback(episode, session!.accessToken);
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
    final summary = await repository.interactionSummary(
      dramaId,
      session!.accessToken,
    );
    interactions[dramaId] = summary;
    if (summary.isFavorite) favorites.add(dramaId);
    notifyListeners();
    return summary;
  }

  Future<void> toggleLike(String dramaId) async {
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
    interactions[dramaId] = summary;
    notifyListeners();
  }

  Future<void> login(String email, String password) async {
    session = await repository.login(email, password);
    notifyListeners();
  }

  void logout() {
    session = null;
    notifyListeners();
  }

  Future<void> toggleFavorite(String dramaId) async {
    final favorite = !favorites.contains(dramaId);
    if (session != null) {
      await repository.setFavorite(dramaId, session!.accessToken, favorite);
    }
    favorite ? favorites.add(dramaId) : favorites.remove(dramaId);
    await (await SharedPreferences.getInstance()).setStringList(
      'favorites',
      favorites.toList(),
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
    history.remove(dramaId);
    history.insert(0, dramaId);
    if (history.length > 100) history.removeRange(100, history.length);
    await (await SharedPreferences.getInstance()).setStringList(
      'history',
      history,
    );
    notifyListeners();
  }
}

const _demoDramas = [
  Drama(
    id: 'demo-1',
    title: 'The Last Contract',
    totalEpisodes: 42,
    palette: 0,
    summary: 'She signed a marriage contract to save her family, then discovered the stranger was the heir everyone feared.',
    episodes: [
      Episode(
        id: 'demo-1-1',
        number: 1,
        title: 'The Agreement',
        durationSeconds: 78,
        previewSeconds: 78,
      ),
    ],
  ),
  Drama(
    id: 'demo-2',
    title: 'Reborn for Revenge',
    totalEpisodes: 56,
    palette: 1,
    summary: 'A second chance turns betrayal into a carefully planned return.',
    episodes: [
      Episode(
        id: 'demo-2-1',
        number: 1,
        title: 'Back to That Night',
        durationSeconds: 82,
        previewSeconds: 82,
      ),
    ],
  ),
  Drama(
    id: 'demo-3',
    title: 'My Secret CEO',
    totalEpisodes: 36,
    palette: 2,
    summary: 'An ordinary first day at work becomes a secret neither of them can reveal.',
    episodes: [
      Episode(
        id: 'demo-3-1',
        number: 1,
        title: 'First Day',
        durationSeconds: 69,
        previewSeconds: 30,
        pointsAmount: 5,
      ),
    ],
  ),
];
