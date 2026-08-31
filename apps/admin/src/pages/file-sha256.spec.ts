import { describe, expect, it } from 'vitest';

import { sha256Blob } from './file-sha256';

describe('incremental browser file SHA-256', () => {
  it('matches standard SHA-256 vectors across empty and multi-chunk blobs', async () => {
    await expect(sha256Blob(new Blob([]))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    await expect(sha256Blob(new Blob(['abc']))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const bytes = new Uint8Array(4 * 1024 * 1024 + 17).fill(0x61);
    const result = await sha256Blob(new Blob([bytes]));
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toBe(await sha256Blob(new Blob([bytes.slice(0, 1_000_000), bytes.slice(1_000_000)])));
  });
});
