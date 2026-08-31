const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

class IncrementalSha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(bytes: Uint8Array): void {
    if (this.finished) throw new Error('SHA-256 has already finished');
    this.bytesHashed += bytes.length;
    let offset = 0;
    if (this.pendingLength) {
      const needed = 64 - this.pendingLength;
      const take = Math.min(needed, bytes.length);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === 64) {
        this.process(this.pending);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= bytes.length) {
      this.process(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.length) {
      this.pending.set(bytes.subarray(offset), 0);
      this.pendingLength = bytes.length - offset;
    }
  }

  hexDigest(): string {
    if (this.finished) throw new Error('SHA-256 has already finished');
    this.finished = true;
    const bitLengthHigh = Math.floor((this.bytesHashed * 8) / 0x1_0000_0000);
    const bitLengthLow = (this.bytesHashed * 8) >>> 0;
    this.pending[this.pendingLength++] = 0x80;
    if (this.pendingLength > 56) {
      this.pending.fill(0, this.pendingLength);
      this.process(this.pending);
      this.pendingLength = 0;
    }
    this.pending.fill(0, this.pendingLength, 56);
    writeUint32(this.pending, 56, bitLengthHigh);
    writeUint32(this.pending, 60, bitLengthLow);
    this.process(this.pending);
    return [...this.state].map((value) => value.toString(16).padStart(8, '0')).join('');
  }

  private process(block: Uint8Array): void {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] = (
        ((block[offset] ?? 0) << 24)
        | ((block[offset + 1] ?? 0) << 16)
        | ((block[offset + 2] ?? 0) << 8)
        | (block[offset + 3] ?? 0)
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a!) >>> 0;
    this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0;
    this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0;
    this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0;
    this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}

export async function sha256Blob(
  blob: Blob,
  options: { onProgress?(ratio: number): void; signal?: AbortSignal } = {},
): Promise<string> {
  const hasher = new IncrementalSha256();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    if (options.signal?.aborted) throw new DOMException('Hashing was cancelled', 'AbortError');
    const end = Math.min(blob.size, offset + chunkSize);
    hasher.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    options.onProgress?.(end / blob.size);
  }
  if (blob.size === 0) options.onProgress?.(1);
  return hasher.hexDigest();
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value >>> 24;
  target[offset + 1] = value >>> 16;
  target[offset + 2] = value >>> 8;
  target[offset + 3] = value;
}
