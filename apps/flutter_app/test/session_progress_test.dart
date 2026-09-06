import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:night_flix/src/drama_repository.dart';
import 'package:night_flix/src/models.dart';

const endpoint = 'https://tenant-a.example.test';
const firstEpisode = Episode(
  id: 'episode-a',
  number: 1,
  title: 'A',
  durationSeconds: 60,
  previewSeconds: 0,
);
Map<String, dynamic> credentials(String access, String refresh) => {
  'accessToken': access,
  'refreshToken': refresh,
  'deviceToken': 'stable-device',
  'principal': {'accountId': 'account-a'},
  'email': 'a@example.test',
};
http.Response jsonResponse(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('concurrent 401s share a single refresh, preserve device, restore securely and revoke on logout', () async {
    final requests = <http.Request>[];
    var refreshes = 0;
    final refreshGate = Completer<void>();
    await http.runWithClient(
      () async {
        final repo = DramaRepository(apiBaseUrl: endpoint);
        final user = await repo.login('a@example.test', 'password');
        final calls = [
          repo.playback(firstEpisode, user.accessToken),
          repo.playback(firstEpisode, user.accessToken),
        ];
        while (refreshes == 0) {
          await Future<void>.delayed(Duration.zero);
        }
        refreshGate.complete();
        expect(
          (await Future.wait(calls)).map((e) => e.access),
          everyElement('full'),
        );
        expect(refreshes, 1);
        final restored = DramaRepository(apiBaseUrl: endpoint);
        await restored.restoreSession();
        expect(restored.session?.accessToken, 'new');
        expect(restored.session?.accountId, 'account-a');
        final otherTenant = DramaRepository(
          apiBaseUrl: 'https://tenant-b.example.test',
        );
        await otherTenant.restoreSession();
        expect(otherTenant.session, isNull);
        await restored.logout();
        await restored.restoreSession();
        expect(restored.session, isNull);
        await restored.login('a@example.test', 'password');
        final logins = requests
            .where((r) => r.url.path.endsWith('/login'))
            .toList();
        expect(jsonDecode(logins.last.body)['deviceToken'], 'stable-device');
        expect(
          jsonDecode(
            requests.singleWhere((r) => r.url.path.endsWith('/logout')).body,
          )['refreshToken'],
          'rotated',
        );
      },
      () => MockClient((request) async {
        requests.add(request);
        if (request.url.path.endsWith('/login')) {
          return jsonResponse(credentials('old', 'refresh'));
        }
        if (request.url.path.endsWith('/refresh')) {
          refreshes++;
          await refreshGate.future;
          return jsonResponse(credentials('new', 'rotated'));
        }
        if (request.url.path.endsWith('/logout')) return jsonResponse({});
        return request.headers['authorization'] == 'Bearer new'
            ? jsonResponse({
                'access': 'full',
                'url': 'https://media.example.test/a.mp4',
              })
            : jsonResponse({'message': 'expired'}, 401);
      }),
    );
  });

  test('logout during refresh cannot resurrect credentials or return old-account playback', () async {
    final started = Completer<void>(), release = Completer<void>();
    String? revoked;
    await http.runWithClient(
      () async {
        final repo = DramaRepository(apiBaseUrl: endpoint);
        final user = await repo.login('a@example.test', 'password');
        final pending = repo.playback(firstEpisode, user.accessToken);
        final rejected = expectLater(pending, throwsA(isA<ApiException>()));
        await started.future;
        final logout = repo.logout();
        expect(repo.session, isNull);
        release.complete();
        await Future.wait([rejected, logout]);
        expect(revoked, 'rotated');
        await repo.restoreSession();
        expect(repo.session, isNull);
        await expectLater(
          repo.playback(firstEpisode, user.accessToken),
          throwsA(isA<ApiException>()),
        );
      },
      () => MockClient((r) async {
        if (r.url.path.endsWith('/login')) {
          return jsonResponse(credentials('old', 'refresh'));
        }
        if (r.url.path.endsWith('/refresh')) {
          started.complete();
          await release.future;
          return jsonResponse(credentials('new', 'rotated'));
        }
        if (r.url.path.endsWith('/logout')) {
          revoked = jsonDecode(r.body)['refreshToken'] as String;
          return jsonResponse({});
        }
        return jsonResponse({'message': 'expired'}, 401);
      }),
    );
  });

  test(
    'revoked refresh clears local login; temporary network failures retain it',
    () async {
      for (final status in [401, 503]) {
        await http.runWithClient(
          () async {
            final repo = DramaRepository(apiBaseUrl: endpoint);
            final user = await repo.login('a@example.test', 'password');
            await expectLater(
              repo.playback(firstEpisode, user.accessToken),
              throwsA(isA<ApiException>()),
            );
            expect(repo.session == null, status == 401);
            final restored = DramaRepository(apiBaseUrl: endpoint);
            await restored.restoreSession();
            expect(restored.session == null, status == 401);
          },
          () => MockClient(
            (r) async => r.url.path.endsWith('/login')
                ? jsonResponse(credentials('old', 'refresh'))
                : jsonResponse({
                    'message': 'unavailable',
                  }, r.url.path.endsWith('/refresh') ? status : 401),
          ),
        );
      }
    },
  );

  test('guest playback omits authorization; locked response becomes an unlock state', () async {
    await http.runWithClient(
      () async {
        final repo = DramaRepository(apiBaseUrl: endpoint);
        expect((await repo.playback(firstEpisode, '')).locked, isTrue);
      },
      () => MockClient((r) async {
        expect(r.headers.containsKey('authorization'), isFalse);
        return jsonResponse({
          'access': 'locked',
          'message': 'Full playback access is required',
        }, 403);
      }),
    );
  });

  test(
    'restart restores episode and position only within the same account scope',
    () async {
      final repo = DramaRepository(apiBaseUrl: '');
      final app = AppController(repo);
      await app.initialize();
      await app.login('a@example.test', 'password');
      await app.recordProgress(
        PlaybackProgress(
          dramaId: 'demo-1',
          episodeId: 'demo-1-2',
          positionSeconds: 4,
          completed: false,
          updatedAt: DateTime.now(),
        ),
      );
      await app.logout();
      expect(app.progress, isEmpty);
      await app.login('b@example.test', 'password');
      expect(app.progress, isEmpty);
      final restarted = AppController(DramaRepository(apiBaseUrl: ''));
      await restarted.initialize();
      await restarted.login('a@example.test', 'password');
      expect(restarted.progress['demo-1']?.episodeId, 'demo-1-2');
      expect(restarted.progress['demo-1']?.positionSeconds, 4);
    },
  );
}
