import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [OutboxPublisherService],
  exports: [OutboxPublisherService],
})
export class OutboxModule {}
