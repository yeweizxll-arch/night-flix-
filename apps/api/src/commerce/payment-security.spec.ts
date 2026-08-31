import { BadRequestException } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../database/database.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import { sanitizeAuditJson } from '../audit/audit-sanitizer';
import {
  FakePaymentAdapter,
  signFakePaymentWebhook,
} from './payment-adapter';
import type { PaymentCoreService } from './payment-core.service';
import { PaymentCoreService as PaymentCoreServiceImplementation } from './payment-core.service';
import {
  CustomerPaymentController,
  PaymentWebhookController,
} from './payment.controller';

const configId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const originalSecret = process.env.FAKE_PAYMENT_WEBHOOK_SECRET;

beforeAll(() => {
  process.env.FAKE_PAYMENT_WEBHOOK_SECRET =
    'payment-security-spec-secret-with-at-least-thirty-two-characters';
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.FAKE_PAYMENT_WEBHOOK_SECRET;
  else process.env.FAKE_PAYMENT_WEBHOOK_SECRET = originalSecret;
});

describe('payment webhook transport boundary', () => {
  it('marks both customer checkout responses as no-store', () => {
    for (const method of ['create', 'detail'] as const) {
      expect(Reflect.getMetadata(
        HEADERS_METADATA,
        CustomerPaymentController.prototype[method],
      )).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    }
  });

  it('passes the exact raw Buffer and enforces the 64,000-byte ceiling', async () => {
    const handleWebhook = vi.fn(async (
      _configId: string,
      _raw: Buffer,
      _signature: string,
    ) => ({ status: 'processed' }));
    const controller = new PaymentWebhookController({
      handleWebhook,
    } as unknown as PaymentCoreService);
    const raw = Buffer.alloc(64_000, 0x61);

    await expect(controller.webhook(configId, raw, 'ab'.repeat(32)))
      .resolves.toEqual({ status: 'processed' });
    expect(handleWebhook).toHaveBeenCalledWith(configId, raw, 'ab'.repeat(32), 'fake');
    expect(handleWebhook.mock.calls[0]?.[1]).toBe(raw);

    expect(() => controller.webhook(configId, Buffer.alloc(64_001), 'ab'.repeat(32)))
      .toThrow(BadRequestException);
    expect(() => controller.webhook(configId, undefined, 'ab'.repeat(32)))
      .toThrow(BadRequestException);
  });

  it('rejects duplicate raw Stripe-Signature headers and keeps Stripe on its own route', async () => {
    const handleWebhook = vi.fn(async () => ({ status: 'processed' }));
    const controller = new PaymentWebhookController({ handleWebhook } as unknown as PaymentCoreService);
    const raw = Buffer.from('{"type":"event"}');
    const duplicate = {
      raw: {
        rawHeaders: ['Stripe-Signature', 't=1,v1=a', 'stripe-signature', 't=1,v1=b'],
      },
    } as unknown as FastifyRequest;

    expect(() => controller.stripeWebhook(configId, raw, duplicate))
      .toThrow(/stripe-signature must be provided exactly once/i);
    expect(handleWebhook).not.toHaveBeenCalled();

    const single = {
      raw: { rawHeaders: ['Host', 'example.test', 'Stripe-Signature', 't=1,v1=abc'] },
    } as unknown as FastifyRequest;
    await expect(controller.stripeWebhook(configId, raw, single))
      .resolves.toEqual({ status: 'processed' });
    expect(handleWebhook).toHaveBeenCalledWith(configId, raw, 't=1,v1=abc', 'stripe');
  });

  it('rejects future signed events before JSON reaches the payment state machine', () => {
    const adapter = new FakePaymentAdapter();
    for (const occurredAt of [new Date(Date.now() + 2 * 60 * 1_000)]) {
      const raw = Buffer.from(JSON.stringify({
        amountMinor: 100,
        attemptReference: orderId,
        currency: 'USD',
        eventId: `evt_${occurredAt.getTime()}`,
        eventType: 'payment.succeeded',
        externalPaymentId: `fake_pay_${'a'.repeat(32)}`,
        externalTransactionId: `charge_${occurredAt.getTime()}`,
        occurredAt: occurredAt.toISOString(),
      }));
      expect(() => adapter.verifyWebhook(raw, signFakePaymentWebhook(raw)))
        .toThrow(BadRequestException);
    }
  });

  it('rejects duplicate Idempotency-Key header values instead of selecting one', async () => {
    const createPayment = vi.fn();
    const authenticateAccess = vi.fn(async () => ({
      accountId: '33333333-3333-4333-8333-333333333333',
      tenantId: configId,
      username: 'payment-user',
    }));
    const controller = new CustomerPaymentController(
      { createPayment } as unknown as PaymentCoreService,
      { authenticateAccess } as unknown as CustomerAuthenticationService,
      {
        current: vi.fn(() => ({ tenantId: configId, tenantStatus: 'active' })),
      } as unknown as TenantContextService,
    );
    const request = {
      headers: {
        authorization: `Bearer atk_${'a'.repeat(43)}`,
        'idempotency-key': ['payment-key-one', 'payment-key-two'],
      },
    } as unknown as FastifyRequest;

    await expect(controller.create(orderId, {}, request)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('rechecks payload hash when a concurrent event-id insert loses its unique race', async () => {
    const queries: string[] = [];
    let existingReads = 0;
    const transaction = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown[]> => {
      let sql = strings[0] ?? '';
      for (let index = 0; index < values.length; index += 1) {
        sql += `$${index + 1}${strings[index + 1] ?? ''}`;
      }
      queries.push(sql);
      if (sql.includes('from payment_configs as config')) {
        return [{ adapter_code: 'fake', config_id: configId, provider_id: orderId }];
      }
      if (sql.includes('select payload_hash, status from payment_webhook_inbox')) {
        existingReads += 1;
        return existingReads === 1
          ? []
          : [{ payload_hash: '0'.repeat(64), status: 'processed' }];
      }
      if (sql.includes('from payment_attempts as attempt')) {
        return [{
          account_id: '33333333-3333-4333-8333-333333333333',
          amount_minor: 100,
          attempt_created_at: new Date(Date.now() - 1_000),
          attempt_id: orderId,
          collection_mode: 'platform_collect',
          currency: 'USD',
          order_created_at: new Date(Date.now() - 2_000),
          order_expired: false,
          order_expires_at: new Date(Date.now() + 60_000),
          order_id: configId,
          order_status: 'pending_payment',
          provider_id: orderId,
          status: 'pending',
          tenant_id: configId,
        }];
      }
      if (sql.includes('select id from customer_accounts')) {
        return [{ id: '33333333-3333-4333-8333-333333333333' }];
      }
      if (sql.includes('insert into payment_webhook_inbox')) return [];
      return [];
    }) as unknown as DatabaseTransaction;
    Object.assign(transaction, { json: (value: unknown) => JSON.stringify(value) });
    const database = {
      inPlatformContext: <T>(callback: (tx: DatabaseTransaction) => Promise<T>) =>
        callback(transaction),
    } as unknown as DatabaseService;
    const service = new PaymentCoreServiceImplementation(database, {
      require: () => ({
        verifyWebhook: () => ({
          amountMinor: 100,
          attemptReference: orderId,
          currency: 'USD',
          eventId: 'evt_concurrent_collision',
          eventType: 'payment.succeeded',
          externalPaymentId: `fake_pay_${orderId.replaceAll('-', '')}`,
          externalTransactionId: 'charge_concurrent_collision',
          occurredAt: new Date(),
        }),
      }),
    } as never);

    await expect(service.handleWebhook(
      configId,
      Buffer.from('{"concurrent":true}'),
      'valid-signature-from-adapter',
    )).resolves.toEqual({ duplicate: true, status: 'rejected' });
    expect(existingReads).toBe(2);
    expect(queries.some((sql) => sql.includes('commerce.payment.webhook.event_reuse'))).toBe(true);
  });

  it('redacts checkout references and payment credentials from audit responses', () => {
    const sanitized = sanitizeAuditJson({
      checkoutReference: 'https://provider.example/checkout?client_secret=secret-value',
      credentialCiphertext: 'encrypted-secret-value',
      externalPaymentId: 'provider-payment-id',
      metadata: { rawWebhookPayload: '{"card":"sensitive"}' },
    });
    expect(sanitized).toEqual({
      checkoutReference: '[REDACTED]',
      credentialCiphertext: '[REDACTED]',
      externalPaymentId: 'provider-payment-id',
      metadata: { rawWebhookPayload: '[REDACTED]' },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/secret-value|sensitive/);
  });
});
