import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { DatabaseService } from '../database/database.service';
import { ContentScheduleWorkerService } from '../content/content-schedule-worker.service';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service';
import { ReferralSettlementWorkerService } from '../referrals/referral.service';
import { WorkerModule } from '../workers/worker.module';
import { NotificationWorkerService } from '../notifications/notification-worker.service';
import { CommunicationWorkerService } from '../communications/communication-worker.service';
import { TransactionalNotificationOutboxWorkerService } from '../notifications/transactional-notification-outbox-worker.service';
import { TenantContentImportWorkerService } from '../content/tenant-content-portability.service';
import { PrivacyErasureWorkerService } from '../privacy/privacy-erasure-worker.service';

async function main(): Promise<void> {
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  application.enableShutdownHooks();
  await application.get(DatabaseService).validateProductionSecurity();
  const publisher = application.get(OutboxPublisherService);
  const scheduler = application.get(ContentScheduleWorkerService);
  const referralSettlements = application.get(ReferralSettlementWorkerService);
  const notifications = application.get(NotificationWorkerService);
  const communications = application.get(CommunicationWorkerService);
  const transactionalNotifications = application.get(TransactionalNotificationOutboxWorkerService);
  const contentImports = application.get(TenantContentImportWorkerService);
  const privacyErasures = application.get(PrivacyErasureWorkerService);
  await publisher.recoverStaleLocks();
  await scheduler.recoverStaleLocks();
  await notifications.recoverStaleLocks();
  await communications.recoverStaleLocks();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const pollIntervalMs = integerEnvironment('WORKER_POLL_INTERVAL_MS', 500, 100, 60_000);
  while (!stopping) {
    const schedules = await scheduler.processDue();
    const commissions = await referralSettlements.settleDue();
    const transactionalNotificationResult = await transactionalNotifications.processAvailable();
    const notificationResult = await notifications.processAvailable();
    const communicationResult = await communications.processAvailable();
    const contentImportResult = await contentImports.processAvailable();
    const privacyErasureResult = await privacyErasures.processDue();
    const result = await publisher.publishAvailable();
    if (result.claimed === 0 && schedules.claimed === 0 && commissions.settled === 0
      && notificationResult.jobs === 0 && notificationResult.deliveries === 0
      && transactionalNotificationResult.processed === 0
      && communicationResult.claimed === 0 && contentImportResult.claimed === 0
      && privacyErasureResult.inspected === 0) {
      await wait(pollIntervalMs);
    }
  }
  await application.close();
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
