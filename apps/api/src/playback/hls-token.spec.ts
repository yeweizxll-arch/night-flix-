import { describe, expect, it } from 'vitest';
import { hlsToken, readHlsToken, rewriteHlsPlaylist, type HlsGrant } from './hls-token';
const secret = 'hls-regression-only-key-with-at-least-32-bytes';
const grant: HlsGrant = {
  tenantId: '018f2f45-7f5e-7e70-b17f-f6e773573101',
  episodeId: '018f2f45-7f5e-7e70-b17f-f6e773573108',
  mediaId: '018f2f45-7f5e-7e70-b17f-f6e773573111',
  root: 'shows/version1/episode1/master.m3u8', key: 'shows/version1/episode1/master.m3u8',
  expires: 1800000180000,
};
describe('HLS signed resources', () => {
  it('verifies integrity and expiry and preserves scope', () => {
    const token = hlsToken(grant, secret);
    expect(readHlsToken(token, secret, 1800000000000)).toEqual(grant);
    expect(() => readHlsToken(token + 'x', secret, 1800000000000)).toThrow();
    expect(() => readHlsToken(token, secret, grant.expires)).toThrow();
    expect(() => readHlsToken(token, 'another-32-byte-signing-key-value!', 1800000000000)).toThrow();
    expect(() => hlsToken({ ...grant, key: 'shows/version1/episode2/key.bin' }, secret)).toThrow();
    expect(() => hlsToken({ ...grant, root: 'master.m3u8' }, secret)).toThrow();
  });
  it('signs variants, subtitles, initialization segments, AES keys and nested resources', () => {
    const resources: HlsGrant[] = [];
    const output = rewriteHlsPlaylist([
      '#EXTM3U', '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="sub/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'video/main.m3u8',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6,', 'seg/001.ts', '#EXT-X-ENDLIST',
    ].join('\n'), grant, (next) => { resources.push(next); return 'https://agent.example/resource?token=' + hlsToken(next, secret); });
    expect(resources.map((r) => r.key)).toEqual([
      'shows/version1/episode1/sub/en.m3u8', 'shows/version1/episode1/video/main.m3u8',
      'shows/version1/episode1/key.bin', 'shows/version1/episode1/init.mp4', 'shows/version1/episode1/seg/001.ts',
    ]);
    expect(output).not.toContain('URI="key.bin"');
    expect(resources.every((r) => r.tenantId === grant.tenantId && r.expires === grant.expires)).toBe(true);
    expect(rewriteHlsPlaylist('#EXTM3U\n../key.bin', { ...grant, key: 'shows/version1/episode1/video/main.m3u8' },
      (next) => next.key)).toContain('shows/version1/episode1/key.bin');
  });
  it('fails closed on external, absolute, traversing, ambiguous or unsupported references', () => {
    for (const reference of ['../key.bin', '%2e%2e/key.bin', '//evil.test/key', 'https://evil.test/x',
      '/other/key', 'file:///etc/passwd', 'data:text/plain,key', 'sub\\..\\key', 'x?secret=1', 'x#fragment']) {
      expect(() => rewriteHlsPlaylist('#EXTM3U\n' + reference, grant, () => 'url')).toThrow();
      expect(() => rewriteHlsPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="' + reference + '"', grant, () => 'url')).toThrow();
    }
    expect(() => rewriteHlsPlaylist('#EXTM3U\n#EXT-X-DEFINE:NAME="x",VALUE="y"', grant, () => '')).toThrow();
    expect(() => rewriteHlsPlaylist('#EXTM3U\n#EXT-X-KEY:URI=key.bin', grant, () => '')).toThrow();
    expect(() => rewriteHlsPlaylist('#EXTM3U\n#EXT-X-KEY:URI="key.bin",URI=other.bin', grant, () => '')).toThrow();
    expect(() => hlsToken({ ...grant, mediaId: '018f2f45---------------------------11' }, secret)).toThrow();
  });
});
