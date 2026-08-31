import { describe, expect, it } from 'vitest';

import { generateStorageObjectKey } from './object-key';

describe('generateStorageObjectKey', () => {
  it('uses independent random scope and object components without tenant identifiers', () => {
    const keys = new Set(Array.from({ length: 100 }, () => (
      generateStorageObjectKey('video', '.MP4')
    )));
    expect(keys).toHaveLength(100);
    for (const key of keys) {
      expect(key).toMatch(/^tenant-media\/[A-Za-z0-9_-]{16}\/video\/[A-Za-z0-9_-]{43}\.mp4$/);
      expect(key).not.toContain('018f');
    }
  });

  it.each(['../mp4', 'tar.gz', '/mp4', 'mp4?', ''])('rejects or normalizes unsafe extension %j', (extension) => {
    if (extension === '') {
      expect(generateStorageObjectKey('file', extension)).not.toContain('.');
    } else {
      expect(() => generateStorageObjectKey('file', extension)).toThrow(TypeError);
    }
  });
});
