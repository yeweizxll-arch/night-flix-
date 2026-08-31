import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import {
  AwsSdkS3CompatibleStorageAdapter,
  S3_COMPATIBLE_STORAGE_ADAPTER,
} from './s3-compatible.adapter';
import { StorageCredentialCipher } from './storage-credentials';
import {
  PlatformStorageProviderController,
  TenantStorageProviderController,
} from './storage-provider.controller';
import { StorageProviderService } from './storage-provider.service';
import {
  PlatformStorageUploadController,
  TenantStorageUploadController,
} from './storage-upload.controller';
import { StorageUploadService } from './storage-upload.service';

@Module({
  imports: [DatabaseModule],
  controllers: [
    PlatformStorageProviderController,
    TenantStorageProviderController,
    TenantStorageUploadController,
    PlatformStorageUploadController,
  ],
  providers: [
    StorageProviderService,
    StorageUploadService,
    {
      provide: StorageCredentialCipher,
      useFactory: () => new StorageCredentialCipher(),
    },
    {
      provide: S3_COMPATIBLE_STORAGE_ADAPTER,
      useFactory: () => new AwsSdkS3CompatibleStorageAdapter(),
    },
  ],
  exports: [StorageCredentialCipher, S3_COMPATIBLE_STORAGE_ADAPTER],
})
export class StorageModule {}
