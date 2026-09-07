import { BadRequestException } from '@nestjs/common';

import {
  COMMERCE_CURRENCIES,
  COMMERCE_LOCALES,
  type CommerceCurrency,
  type CommerceLocale,
  type CommerceProductType,
  type CommerceTranslationInput,
} from './commerce.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

export function requireCode(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('code is required');
  const code = value.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) throw new BadRequestException('code is invalid');
  return code;
}

export function requireCurrency(value: unknown): CommerceCurrency {
  if (
    typeof value !== 'string'
    || !COMMERCE_CURRENCIES.includes(value as CommerceCurrency)
  ) {
    throw new BadRequestException('currency is invalid');
  }
  return value as CommerceCurrency;
}

export function requireLocale(value: unknown): CommerceLocale {
  if (
    typeof value !== 'string'
    || !COMMERCE_LOCALES.includes(value as CommerceLocale)
  ) {
    throw new BadRequestException('locale is invalid');
  }
  return value as CommerceLocale;
}

export function requireProductType(value: unknown): CommerceProductType {
  if (
    value !== 'membership'
    && value !== 'drama'
    && value !== 'episode'
    && value !== 'points_topup'
  ) {
    throw new BadRequestException('productType is invalid');
  }
  return value;
}

export function requirePositiveSafeInteger(
  value: unknown,
  field: string,
  maximum = 9_000_000_000_000_000,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

export function requireNonNegativeSafeInteger(
  value: unknown,
  field: string,
  maximum = 9_000_000_000_000_000,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

export function requireStatus(value: unknown): 'active' | 'disabled' {
  if (value === undefined) return 'active';
  if (value !== 'active' && value !== 'disabled') {
    throw new BadRequestException('status is invalid');
  }
  return value;
}

export function requireTranslations(value: unknown): CommerceTranslationInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const locales = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new BadRequestException('translation is invalid');
    }
    const translation = entry as Record<string, unknown>;
    const locale = requireLocale(translation.locale);
    if (locales.has(locale)) throw new BadRequestException('translation locale is duplicated');
    locales.add(locale);
    if (typeof translation.name !== 'string') {
      throw new BadRequestException('translation name is required');
    }
    const name = translation.name.trim();
    if (name.length < 1 || name.length > 200) {
      throw new BadRequestException('translation name is invalid');
    }
    const description = translation.description ?? '';
    if (typeof description !== 'string' || description.length > 4_000) {
      throw new BadRequestException('translation description is invalid');
    }
    return { description, locale, name };
  });
}

export function amountNumber(value: string | number | bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Stored monetary amount is outside the supported range');
  }
  return amount;
}

/** Ledger changes may be negative; balances and prices must still use amountNumber. */
export function signedAmountNumber(value: string | number | bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new Error('Stored monetary amount is outside the supported range');
  }
  return amount;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === '23505',
  );
}
