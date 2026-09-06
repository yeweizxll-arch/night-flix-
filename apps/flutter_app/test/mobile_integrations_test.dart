import 'package:flutter_test/flutter_test.dart';
import 'package:night_flix/src/mobile_links.dart';
import 'package:night_flix/src/tenant_ads.dart';

void main() {
  test('deep links accept only the configured tenant and a single drama UUID', () {
    const id = '018f2f45-7f5e-7e70-b17f-f6e773573108';
    expect(linkedDramaId(Uri.parse('https://watch.example.com/dramas/$id'), 'watch.example.com'), id);
    for (final url in [
      'https://other.example.com/dramas/$id', 'http://watch.example.com/dramas/$id',
      'https://x@watch.example.com/dramas/$id', 'https://watch.example.com:444/dramas/$id',
      'https://watch.example.com/dramas/$id?url=https://evil.test',
      'https://watch.example.com/dramas/$id#other', 'https://watch.example.com/dramas/invalid',
      'https://watch.example.com/dramas/$id/extra',
    ]) {
      expect(linkedDramaId(Uri.parse(url), 'watch.example.com'), isNull, reason: url);
    }
    expect(linkedDramaId(Uri.parse('https://watch.example.com/dramas/$id'), null), isNull);
  });
  test('ad units never fall across iOS and Android or disabled configurations', () {
    const android = 'ca-app-pub-1111111111111111/1111111111';
    const ios = 'ca-app-pub-2222222222222222/2222222222';
    final config = {'android': {'rewardedEpisode': android}, 'ios': {'rewardedEpisode': ios}};
    expect(tenantAdUnit(config, 'android', 'rewardedEpisode'), android);
    expect(tenantAdUnit(config, 'ios', 'rewardedEpisode'), ios);
    expect(tenantAdUnit(config, 'ios', 'native'), isNull);
    expect(tenantAdUnit({...config, 'enabled': false}, 'android', 'rewardedEpisode'), isNull);
    expect(tenantAdUnit({'nativeAndroid': 'fake-unit'}, 'android', 'native'), isNull);
  });
  test('full screen frequency uses both a global gap and format-specific cooldown', () {
    var now = DateTime.utc(2026, 9, 6);
    final frequency = AdFrequency(now: () => now);
    expect(frequency.available('interstitial', const Duration(minutes: 3)), isTrue);
    frequency.shown('interstitial');
    expect(frequency.available('appOpen', const Duration(minutes: 2)), isFalse);
    now = now.add(const Duration(seconds: 30));
    expect(frequency.available('appOpen', const Duration(minutes: 2)), isTrue);
    expect(frequency.available('interstitial', const Duration(minutes: 3)), isFalse);
    now = now.add(const Duration(minutes: 3));
    expect(frequency.available('interstitial', const Duration(minutes: 3)), isTrue);
  });
}
