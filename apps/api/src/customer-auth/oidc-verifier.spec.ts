import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyIdentityJwt } from './oidc-verifier';

describe('tenant identity cryptographic verification', () => {
  it('requires trusted signature, audience, issuer, expiry, recent issuance and Apple nonce', async () => {
    const key = await generateKeyPair('RS256');
    const attacker = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({ keys: [await exportJWK(key.publicKey)] });
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 'provider-subject', iss: 'https://appleid.apple.com', aud: 'com.tenant.one',
      iat: now, exp: now + 300, nonce: 'server-generated-nonce-hash' };
    const sign = (payload = claims, signingKey = key.privateKey) => new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256' }).sign(signingKey);
    await expect(verifyIdentityJwt(await sign(), 'apple', claims.aud, claims.nonce, jwks))
      .resolves.toEqual({ subject: claims.sub });
    for (const override of [{ aud: 'com.another.tenant' }, { iss: 'https://attacker.test' },
      { exp: now - 120 }, { iat: now - 601 }, { nonce: 'replayed-other-challenge' }]) {
      await expect(verifyIdentityJwt(await sign({ ...claims, ...override }), 'apple', claims.aud, claims.nonce, jwks)).rejects.toThrow();
    }
    await expect(verifyIdentityJwt(await sign(claims, attacker.privateKey), 'apple', claims.aud, claims.nonce, jwks)).rejects.toThrow();
    const google = await sign({ ...claims, iss: 'https://accounts.google.com' });
    await expect(verifyIdentityJwt(google, 'google', claims.aud, '', jwks)).resolves.toEqual({ subject: claims.sub });
  });
});
