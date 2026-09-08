import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';

class DelayedLibrary extends DramaRepository {
  DelayedLibrary() : super(apiBaseUrl: 'https://local.example.test');
  final readStarted = Completer<void>();
  final releaseRead = Completer<void>();
  int reads = 0;
  @override
  Future<List<PlaybackProgress>> watchHistory(String token) async => [];
  @override
  Future<List<String>> savedDramas(String token) async {
    if (reads++ > 0) return ['drama'];
    readStarted.complete();
    await releaseRead.future;
    return [];
  }

  @override
  Future<List<String>> followedDramas(String token) async => [];
  @override
  Future<void> setFavorite(String dramaId, String token, bool favorite) async {}
  @override
  Future<void> setFollowing(String dramaId, bool followed) async {}
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  test('a delayed library snapshot cannot undo completed favorite and follow writes', () async {
    final repo = DelayedLibrary();
    repo.session = const UserSession(
      accessToken: 'token',
      refreshToken: 'refresh',
      email: 'local@example.test',
      accountId: 'a',
    );
    final app = AppController(repo);
    final refresh = app.refreshLibrary();
    await repo.readStarted.future;
    await app.toggleFavorite('drama');
    await app.toggleFollowing('drama');
    repo.releaseRead.complete();
    await refresh;
    expect(app.favorites, contains('drama'));
    expect(app.following, contains('drama'));
    final prefs = await SharedPreferences.getInstance();
    expect(
      prefs.getStringList('${app.accountScope}:following'),
      contains('drama'),
    );
    app.dispose();
  });
  test('an older refresh cannot replace a newer library snapshot', () async {
    final repo = DelayedLibrary();
    repo.session = const UserSession(
      accessToken: 'token',
      refreshToken: 'refresh',
      email: 'local@example.test',
      accountId: 'a',
    );
    final app = AppController(repo);
    app.dramas = const [
      Drama(id: 'drama', title: 'QA', summary: '', totalEpisodes: 0),
    ];
    final old = app.refreshLibrary();
    await repo.readStarted.future;
    await app.refreshLibrary();
    expect(app.favorites, contains('drama'));
    repo.releaseRead.complete();
    await old;
    expect(app.favorites, contains('drama'));
    app.dispose();
  });
}
