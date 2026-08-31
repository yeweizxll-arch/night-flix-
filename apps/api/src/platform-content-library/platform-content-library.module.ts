import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { PlatformContentLibraryController } from './platform-content-library.controller';
import { PlatformContentLibraryService } from './platform-content-library.service';

@Module({
  imports: [DatabaseModule],
  controllers: [PlatformContentLibraryController],
  providers: [PlatformContentLibraryService],
  exports: [PlatformContentLibraryService],
})
export class PlatformContentLibraryModule {}
