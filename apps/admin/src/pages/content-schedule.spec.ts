import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { dateTimeFormProps } from './ContentScheduleFields';
import { localDateTimeToIso } from './legal-ui';
describe('admin date picker values', () => {
  it('round-trips an absolute time without timezone drift and preserves clearing', () => {
    const iso = '2026-09-07T11:00:00.000Z';
    const value = dateTimeFormProps.getValueProps(iso).value!;
    expect(dateTimeFormProps.normalize(value)).toBe(iso);
    expect(localDateTimeToIso(dateTimeFormProps.normalize(dayjs(iso))!)).toBe(iso);
    expect(dateTimeFormProps.getValueProps(undefined).value).toBeNull();
    expect(dateTimeFormProps.normalize(null)).toBeUndefined();
  });
});
