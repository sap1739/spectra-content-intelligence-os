import { Global, Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from './audit.service';
import { QueueService } from './queue.service';

/** Global infrastructure providers shared by every feature module. */
@Global()
@Module({
  providers: [PrismaService, RedisService, AuditService, QueueService],
  exports: [PrismaService, RedisService, AuditService, QueueService],
})
export class InfraModule {}
