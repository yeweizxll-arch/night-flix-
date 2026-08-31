import { Module } from '@nestjs/common';

import { AppBuildModule } from '../app-builds';

@Module({ imports: [AppBuildModule] })
export class AppBuildWorkerModule {}
