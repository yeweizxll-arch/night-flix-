import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required');
  }

  const migrationsDirectory = await locateMigrationsDirectory();
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  if (!filenames.length) {
    throw new Error(`No migrations found in ${migrationsDirectory}`);
  }

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const connection = await client.reserve();
  try {
    await connection`select pg_advisory_lock(hashtext('drama_saas_migrations'))`;
    await connection.unsafe(`
      create table if not exists public.schema_migrations (
        filename text primary key,
        checksum_sha256 text not null,
        applied_at timestamptz not null default statement_timestamp()
      )
    `);

    for (const filename of filenames) {
      const sqlText = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const existing = await connection<{ checksum_sha256: string }[]>`
        select checksum_sha256
        from public.schema_migrations
        where filename = ${filename}
      `;
      if (existing[0]) {
        if (existing[0].checksum_sha256 !== checksum) {
          throw new Error(`Applied migration checksum changed: ${filename}`);
        }
        continue;
      }

      await connection.unsafe(sqlText);
      await connection`
        insert into public.schema_migrations (filename, checksum_sha256)
        values (${filename}, ${checksum})
      `;
      process.stdout.write(`applied ${filename}\n`);
    }
  } finally {
    await connection`select pg_advisory_unlock(hashtext('drama_saas_migrations'))`.catch(
      () => undefined,
    );
    connection.release();
    await client.end({ timeout: 5 });
  }
}

async function locateMigrationsDirectory(): Promise<string> {
  const candidates = [
    resolve(process.cwd(), 'database/migrations'),
    resolve(process.cwd(), '../../database/migrations'),
  ];
  for (const candidate of candidates) {
    try {
      const files = await readdir(candidate);
      if (files.some((filename) => filename.endsWith('.sql'))) {
        return candidate;
      }
    } catch {
      // Try the next workspace layout.
    }
  }
  throw new Error('database/migrations directory could not be located');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

