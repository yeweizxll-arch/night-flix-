import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable,
  NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { S3_COMPATIBLE_STORAGE_ADAPTER, type S3CompatibleStorageAdapter } from '../storage/s3-compatible.adapter';
import { StorageCredentialCipher } from '../storage/storage-credentials';
import { validatePublicHttpsOrigin } from '../storage/storage-endpoint-policy';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { hlsToken, readHlsToken, rewriteHlsPlaylist, type HlsGrant } from './hls-token';
import type { PlaybackViewer } from './playback.types';

@Injectable()
export class HlsPlaybackService {
  private activeReads = 0;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CustomerPlaybackAccessService) private readonly access: CustomerPlaybackAccessService,
    @Inject(StorageCredentialCipher) private readonly cipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER) private readonly storage: S3CompatibleStorageAdapter,
  ) {}

  issue(viewer: PlaybackViewer, episodeId: string, mediaId: string, objectKey: string, seconds: number, origin: string) {
    const expiresAt = new Date(Date.now() + seconds * 1000);
    const grant: HlsGrant = { ...viewer, episodeId, mediaId, root: objectKey, key: objectKey, expires: expiresAt.getTime() };
    return { expiresAt, url: this.url(grant, origin) };
  }

  private url(grant: HlsGrant, origin: string) {
    const base = validatePublicHttpsOrigin(origin);
    return `${base.origin}/api/v1/customer/playback/hls/resource?token=${hlsToken(grant)}`;
  }

  async read(token: unknown, tenantId: string, origin: string, range?: string) {
    let grant: HlsGrant;
    try { grant = readHlsToken(token); } catch { throw new ForbiddenException('Playback token is invalid or expired'); }
    if (grant.tenantId !== tenantId) throw new ForbiddenException('Playback token belongs to another tenant');
    if (range && (!/^bytes=\d+-\d*$/.test(range) || range.length > 80)) throw new BadRequestException('Invalid byte range');
    // Bounded per-process buffering: <=16 * 8 MiB; no unbounded pending queue.
    if (this.activeReads >= 16) throw new HttpException('Playback is busy; retry shortly', 429);
    this.activeReads++;
    try {
      return await this.database.inTenantContext(tenantId, async (sql) => {
        // Recheck every manifest, key and segment, including emergency/geo/account state.
        const access = await this.access.resolveInTransaction(sql, grant, grant.episodeId);
        const mediaId = access.access === 'preview' ? access.previewMediaAssetId
          : access.access === 'full' ? access.mediaAssetId : undefined;
        if (mediaId !== grant.mediaId) throw new ForbiddenException('Playback access is no longer available');
        const rows = await sql<Array<{
          provider_id: string; owner_type: 'platform' | 'tenant'; owner_tenant_id: string | null;
          credential_ciphertext: string; key_version: number; bucket: string; endpoint: string | null;
          source_reference: { versionId?: string; resourceVersions?: Record<string, string> } | null;
        }>>`
          select provider.id as provider_id, provider.owner_type, provider.owner_tenant_id,
            provider.credential_ciphertext, provider.key_version, provider.bucket, provider.endpoint,
            media.metadata_json -> 'sourceReference' as source_reference
          from media_assets media join storage_providers provider on provider.id = media.storage_provider_id
          where media.id = ${mediaId} and media.object_key = ${grant.root}
            and media.source_url is null and media.status = 'ready' and media.deleted_at is null
            and media.kind = 'video' and media.mime_type in ('application/vnd.apple.mpegurl', 'application/x-mpegurl')
            and provider.provider = 's3' and provider.status = 'active'
            and ((provider.owner_type = 'platform' and provider.owner_tenant_id is null)
              or (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId}
                and media.owner_type = 'tenant' and media.owner_tenant_id = ${tenantId}))
            and app.lock_customer_row('media_assets', media.id, to_jsonb(media.*))
            and app.lock_customer_row('storage_providers', provider.id, to_jsonb(provider.*))
        `;
        const asset = rows[0];
        if (!asset) throw new NotFoundException('Secure HLS asset is unavailable');
        const isManifest = grant.key === grant.root || /\.m3u8$/i.test(grant.key);
        if (!asset.source_reference?.resourceVersions?.[grant.root] || !asset.source_reference.resourceVersions[grant.key]) {
          throw new ForbiddenException('HLS resource is outside the published source snapshot');
        }
        if (range && isManifest) throw new BadRequestException('Playlist ranges are not supported');
        if (!this.storage.readObject) throw new ServiceUnavailableException('Secure HLS storage is unavailable');
        try {
          const credentials = this.cipher.decrypt(asset.credential_ciphertext, {
            providerId: asset.provider_id, ownerType: asset.owner_type,
            ownerTenantId: asset.owner_tenant_id, keyVersion: asset.key_version,
          });
          const data = await this.storage.readObject({
            credentials, target: { bucket: asset.bucket, endpoint: asset.endpoint },
            objectKey: grant.key, maxBytes: isManifest ? 1024 * 1024 : 8 * 1024 * 1024,
            versionId: asset.source_reference?.resourceVersions?.[grant.key] ??
              (grant.key === grant.root ? asset.source_reference?.versionId : undefined),
            ...(range ? { range } : {}),
          });
          if (isManifest || data.contentType?.toLowerCase().includes('mpegurl')) {
            const playlist = new TextDecoder('utf-8', { fatal: true }).decode(data.body);
            return { body: Buffer.from(rewriteHlsPlaylist(playlist, grant, (next) => this.url(next, origin))),
              contentType: 'application/vnd.apple.mpegurl', contentRange: undefined };
          }
          return { ...data, contentType: /\.(?:ts)$/i.test(grant.key) ? 'video/mp2t'
            : /\.(?:mp4|m4s)$/i.test(grant.key) ? 'video/mp4'
            : /\.vtt$/i.test(grant.key) ? 'text/vtt' : 'application/octet-stream' };
        } catch {
          throw new ServiceUnavailableException('Secure HLS media is temporarily unavailable');
        }
      });
    } finally { this.activeReads--; }
  }
}
