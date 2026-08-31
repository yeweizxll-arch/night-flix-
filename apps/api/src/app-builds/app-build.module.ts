import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { AppBuildController } from './app-build.controller';
import { AppBuildAssetService } from './app-build-asset.service';
import { AppBuildDownloadService } from './app-build-download.service';
import {
  APP_BUILD_EXECUTOR,
  DisabledAppBuildExecutor,
} from './app-build-executor';
import { AppBuildService } from './app-build.service';
import { AppBuildWorkerService } from './app-build-worker.service';
import { LocalAppBuildExecutor } from './local-app-build-executor';
import { NativeAppBuilder } from './native-app-builder';

@Module({
  imports: [DatabaseModule, StorageModule],
  controllers: [AppBuildController],
  providers: [
    AppBuildService,
    AppBuildAssetService,
    AppBuildDownloadService,
    AppBuildWorkerService,
    LocalAppBuildExecutor,
    NativeAppBuilder,
    {
      provide: APP_BUILD_EXECUTOR,
      inject: [LocalAppBuildExecutor],
      useFactory: (local: LocalAppBuildExecutor) => {
        const selected = process.env.APP_BUILD_EXECUTOR?.trim() || 'disabled';
        if (selected === 'disabled') return new DisabledAppBuildExecutor();
        if (selected === 'local') return local;
        throw new Error('APP_BUILD_EXECUTOR must be disabled or local');
      },
    },
  ],
  exports: [AppBuildService, AppBuildWorkerService, APP_BUILD_EXECUTOR],
})
export class AppBuildModule {}
