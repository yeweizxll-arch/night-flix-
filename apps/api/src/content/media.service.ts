import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ContentMutationMetadata } from './content.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ExternalMediaInput {
  checksum?: string;
  durationSeconds?: number;
  kind: 'file' | 'image' | 'video';
  mimeType?: string;
  sizeBytes?: number;
  sourceUrl: string;
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async registerExternal(
    tenantId: string,
    rawInput: ExternalMediaInput,
    metadata: ContentMutationMetadata,
  ) {
    void tenantId;
    void rawInput;
    void metadata;
    throw new GoneException({
      code: 'EXTERNAL_MEDIA_INGESTION_UNAVAILABLE',
      message: 'External media registration is unavailable; use tenant S3 direct upload',
    });
  }

  async listTenant(
    tenantId: string,
    kindValue: unknown,
    pageValue: number,
    pageSizeValue: number,
  ) {
    assertUuid(tenantId, 'tenantId');
    const kind = optionalKind(kindValue);
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<
        Array<{
          created_at: Date;
          duration_seconds: number | null;
          id: string;
          kind: string;
          mime_type: string | null;
          size_bytes: number | null;
          source_url: string | null;
          status: string;
          total_count: number;
          transcode_status: string;
          version: number;
        }>
      >`
        select
          id, kind, source_url, mime_type, size_bytes, duration_seconds,
          status, transcode_status, version, created_at,
          count(*) over()::integer as total_count
        from media_assets
        where owner_type = 'tenant'
          and owner_tenant_id = ${tenantId}
          and deleted_at is null
          and (${kind ?? null}::text is null or kind = ${kind ?? null})
        order by created_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => ({
          createdAt: row.created_at.toISOString(),
          durationSeconds: row.duration_seconds ?? undefined,
          id: row.id,
          kind: row.kind,
          mimeType: row.mime_type ?? undefined,
          sizeBytes: row.size_bytes ?? undefined,
          sourceUrl: row.source_url ?? undefined,
          status: row.status,
          transcodeStatus: row.transcode_status,
          version: row.version,
        })),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

}

function optionalKind(value: unknown): 'file' | 'image' | 'video' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'file' && value !== 'image' && value !== 'video') {
    throw new BadRequestException('Invalid media kind');
  }
  return value;
}


function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}
