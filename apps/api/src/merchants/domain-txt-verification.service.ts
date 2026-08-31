import { Injectable } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';

@Injectable()
export class DomainTxtVerificationService {
  async hasExactRecord(recordName: string, expectedValue: string): Promise<boolean> {
    try {
      const records = await withTimeout(resolveTxt(recordName), 3_000);
      return records.some((chunks) => chunks.join('').trim() === expectedValue);
    } catch {
      return false;
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
