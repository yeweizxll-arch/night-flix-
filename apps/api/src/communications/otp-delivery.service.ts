import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import type { DatabaseTransaction } from '../database/database.service';
import { CommunicationSecretCipher } from './communication-secret-cipher';
import type { CommunicationChannel, CommunicationLocale } from './communication.types';

@Injectable()
export class OtpDeliveryService {
  constructor(
    @Inject(CommunicationSecretCipher)
    private readonly cipher: CommunicationSecretCipher,
  ) {}

  async enqueueOtp(
    transaction: DatabaseTransaction,
    input: {
      challengeId: string;
      challengeChannel: 'email' | 'phone';
      code: string;
      destination: string;
      expiresAt: Date;
      purpose: string;
      tenantId: string;
      universalCodeEnabled: boolean;
    },
  ): Promise<boolean> {
    const channel: CommunicationChannel = input.challengeChannel === 'phone' ? 'sms' : 'email';
    const configs = await transaction<Array<{ id: string; version: number }>>`
      select id, version from tenant_communication_configs
      where tenant_id = ${input.tenantId} and channel = ${channel} and status = 'active'
      for share
    `;
    const config = configs[0];
    if (!config) {
      if (input.universalCodeEnabled) return false;
      throw unavailable();
    }
    if (!this.cipher.configured) throw unavailable();
    const jobId = uuidV7();
    const encrypted = this.cipher.encryptOtpPayload(
      { code: input.code, destination: input.destination },
      {
        challengeId: input.challengeId,
        channel,
        jobId,
        kind: 'otp',
        purpose: input.purpose,
        tenantId: input.tenantId,
      },
    );
    await transaction`
      insert into customer_otp_delivery_jobs (
        id, tenant_id, challenge_id, config_id, config_version,
        job_type, channel, purpose, payload_ciphertext, key_version, expires_at
      ) values (
        ${jobId}, ${input.tenantId}, ${input.challengeId}, ${config.id}, ${config.version},
        'otp', ${channel}, ${input.purpose}, ${encrypted.ciphertext},
        ${encrypted.keyVersion}, ${input.expiresAt}
      )
    `;
    return true;
  }
}

export function communicationLocale(value: string): CommunicationLocale {
  return ['zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR'].includes(value)
    ? value as CommunicationLocale : 'en-US';
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'OTP_DELIVERY_UNAVAILABLE',
    message: 'Verification delivery is temporarily unavailable',
  });
}
