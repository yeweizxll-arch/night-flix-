import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdMobSsvVerifierService } from './admob-ssv-verifier.service';

const challengeId = '018f2f45-7f5e-7e70-b17f-f6e773573201';

describe('AdMobSsvVerifierService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('verifies the untouched ordered query with the matching AdMob key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      keys: [{ keyId: 12345, pem: publicKey.export({ type: 'spki', format: 'pem' }) }],
    }))));
    const signed = [
      'ad_network=5450213213286189855',
      'ad_unit=ca-app-pub-test/rewarded',
      `custom_data=${challengeId}`,
      'reward_amount=1',
      'reward_item=episode',
      'timestamp=1788227000000',
      'transaction_id=reward-transaction-1',
    ].join('&');
    const signature = sign('sha256', Buffer.from(signed), privateKey)
      .toString('base64url');
    const verifier = new AdMobSsvVerifierService();

    await expect(verifier.verify(
      `/api/v1/customer/rewarded-unlocks/callbacks/admob?${signed}`
      + `&signature=${signature}&key_id=12345`,
    )).resolves.toEqual({
      adUnitId: 'ca-app-pub-test/rewarded',
      challengeId,
      rewardAmount: 1,
      rewardItem: 'episode',
      transactionId: 'reward-transaction-1',
    });
  });

  it('rejects a callback changed after it was signed', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      keys: [{ keyId: 7, pem: publicKey.export({ type: 'spki', format: 'pem' }) }],
    }))));
    const signed = `ad_unit=unit&custom_data=${challengeId}`
      + '&reward_amount=1&reward_item=episode&transaction_id=tx-1';
    const signature = sign('sha256', Buffer.from(signed), privateKey)
      .toString('base64url');
    const verifier = new AdMobSsvVerifierService();

    await expect(verifier.verify(
      `/callback?${signed.replace('reward_amount=1', 'reward_amount=2')}`
      + `&signature=${signature}&key_id=7`,
    )).rejects.toThrow('signature is invalid');
  });
});
