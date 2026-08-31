import { afterEach, describe, expect, it } from 'vitest';

import { TenantDirectoryService } from './tenant-directory.service';

describe('TenantDirectoryService', () => {
  afterEach(() => {
    delete process.env.TENANT_DOMAIN_MAP;
  });

  it('resolves only a configured verified domain', async () => {
    process.env.TENANT_DOMAIN_MAP = JSON.stringify({
      'merchant.example.com': 'tenant-001',
    });

    const directory = new TenantDirectoryService();

    await expect(
      directory.resolveVerifiedHost('Merchant.Example.com:443'),
    ).resolves.toEqual({ id: 'tenant-001', status: 'active' });
    await expect(
      directory.resolveVerifiedHost('attacker.example.com'),
    ).resolves.toBeUndefined();
  });

  it('does not accept a caller supplied tenant when the host is unknown', async () => {
    const directory = new TenantDirectoryService();

    await expect(
      directory.resolveVerifiedHost('unknown.example.com'),
    ).resolves.toBeUndefined();
  });

  it.each([
    'localhost',
    'bad host.example.com',
    'https://merchant.example.com',
    `${'a'.repeat(254)}.example.com`,
  ])('rejects an invalid DNS host before resolution: %s', async (host) => {
    const directory = new TenantDirectoryService();

    await expect(directory.resolveVerifiedHost(host)).resolves.toBeUndefined();
  });
});
