import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { verify as verifySignature } from 'node:crypto';

const KEY_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const CACHE_MS = 24 * 60 * 60 * 1_000;

export interface VerifiedAdMobReward {
  adUnitId: string;
  challengeId: string;
  rewardAmount: number;
  rewardItem: string;
  transactionId: string;
}

@Injectable()
export class AdMobSsvVerifierService {
  private keys = new Map<string, string>();
  private keysLoadedAt = 0;

  async verify(rawUrl: string): Promise<VerifiedAdMobReward> {
    const query = rawUrl.split('?', 2)[1];
    if (!query) throw new BadRequestException('AdMob callback query is required');
    const signatureMarker = '&signature=';
    const signatureIndex = query.indexOf(signatureMarker);
    const keyMarker = '&key_id=';
    const keyIndex = query.indexOf(keyMarker, signatureIndex + signatureMarker.length);
    if (signatureIndex < 1 || keyIndex < 1 || keyIndex <= signatureIndex) {
      throw new BadRequestException('AdMob callback signature fields are invalid');
    }
    const signedContent = query.slice(0, signatureIndex);
    const encodedSignature = query.slice(
      signatureIndex + signatureMarker.length,
      keyIndex,
    );
    const keyId = query.slice(keyIndex + keyMarker.length);
    if (!encodedSignature || !/^\d+$/.test(keyId) || keyId.includes('&')) {
      throw new BadRequestException('AdMob callback signature fields are invalid');
    }
    const publicKey = await this.publicKey(keyId);
    const valid = verifySignature(
      'sha256',
      Buffer.from(signedContent, 'utf8'),
      publicKey,
      decodeWebSafeBase64(encodedSignature),
    );
    if (!valid) throw new UnauthorizedException('AdMob callback signature is invalid');

    const parameters = new URLSearchParams(query);
    const challengeId = required(parameters, 'custom_data', 200);
    const adUnitId = required(parameters, 'ad_unit', 200);
    const transactionId = required(parameters, 'transaction_id', 500);
    const rewardItem = required(parameters, 'reward_item', 100);
    const rewardAmount = Number(required(parameters, 'reward_amount', 30));
    if (!Number.isSafeInteger(rewardAmount) || rewardAmount < 1) {
      throw new BadRequestException('AdMob reward amount is invalid');
    }
    return { adUnitId, challengeId, rewardAmount, rewardItem, transactionId };
  }

  private async publicKey(keyId: string): Promise<string> {
    if (Date.now() - this.keysLoadedAt >= CACHE_MS || this.keys.size === 0) {
      await this.refreshKeys();
    }
    let key = this.keys.get(keyId);
    if (!key) {
      await this.refreshKeys();
      key = this.keys.get(keyId);
    }
    if (!key) throw new UnauthorizedException('AdMob signing key is unknown');
    return key;
  }

  private async refreshKeys(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(KEY_URL, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new ServiceUnavailableException('AdMob signing keys are unavailable');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('AdMob signing keys are unavailable');
    }
    const body = await response.json() as { keys?: unknown };
    if (!Array.isArray(body.keys)) {
      throw new ServiceUnavailableException('AdMob signing keys are invalid');
    }
    const next = new Map<string, string>();
    for (const value of body.keys) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if ((typeof record.keyId === 'number' || typeof record.keyId === 'string')
          && typeof record.pem === 'string' && record.pem.includes('PUBLIC KEY')) {
        next.set(String(record.keyId), record.pem);
      }
    }
    if (next.size === 0) {
      throw new ServiceUnavailableException('AdMob signing keys are invalid');
    }
    this.keys = next;
    this.keysLoadedAt = Date.now();
  }
}

function required(parameters: URLSearchParams, key: string, maximum: number): string {
  const value = parameters.get(key)?.trim();
  if (!value || value.length > maximum) {
    throw new BadRequestException(`AdMob ${key} is invalid`);
  }
  return value;
}

function decodeWebSafeBase64(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(normalized + padding, 'base64');
}
