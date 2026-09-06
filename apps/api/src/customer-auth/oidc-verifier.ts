import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { nativeIntegrationConfig } from '../runtime/native-integration-config';

export type IdentityProvider = 'apple' | 'google';
const keys = {
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), { timeoutDuration: 5000 }),
  google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5000 }),
};

export function validateIdentityClaims(payload: JWTPayload, provider: IdentityProvider, nonceHash: string) {
  if (!payload.sub || payload.sub.length > 255 || !payload.iat || !payload.exp
    || payload.iat > Date.now() / 1000 + 30 || payload.iat < Date.now() / 1000 - 600
    || (provider === 'apple' && payload.nonce !== nonceHash)) {
    throw new UnauthorizedException('Identity token is invalid or stale');
  }
  return { subject: payload.sub };
}

export async function verifyIdentityJwt(token: string, provider: IdentityProvider, audience: string,
  nonceHash: string, jwks: JWTVerifyGetKey = keys[provider]) {
  const result = await jwtVerify(token, jwks, {
    algorithms: ['RS256'], audience,
    issuer: provider === 'apple' ? 'https://appleid.apple.com'
      : ['https://accounts.google.com', 'accounts.google.com'],
    clockTolerance: 30,
  });
  return validateIdentityClaims(result.payload, provider, nonceHash);
}

@Injectable()
export class OidcVerifier {
  async verify(tenantId: string, provider: IdentityProvider, token: string, nonceHash: string) {
    const config = nativeIntegrationConfig(tenantId);
    const audience = provider === 'apple' ? config.appleClientId : config.googleClientId;
    if (!audience || typeof token !== 'string' || token.length > 16384) {
      throw new UnauthorizedException('Identity provider is unavailable');
    }
    try {
      return await verifyIdentityJwt(token, provider, audience, nonceHash);
    } catch {
      // Never echo tokens, claims or upstream responses into logs/client errors.
      throw new UnauthorizedException('Identity verification failed');
    }
  }
}
