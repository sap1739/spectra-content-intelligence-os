import { Global, Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AiTextService } from './ai.service';
import { AuditService } from './audit.service';
import { EmbeddingService } from './embedding.service';
import { QueueService } from './queue.service';
import { SearchProviderService } from './search.service';
import { SocialCryptoService } from './social-crypto.service';
import { StorageHealthService } from './storage-health.service';
import { UsageService } from './usage.service';

/** Global infrastructure providers shared by every feature module. */
@Global()
@Module({
  providers: [
    PrismaService,
    RedisService,
    AuditService,
    QueueService,
    AiTextService,
    EmbeddingService,
    SearchProviderService,
    SocialCryptoService,
    UsageService,
    StorageHealthService,
  ],
  exports: [
    PrismaService,
    RedisService,
    AuditService,
    QueueService,
    AiTextService,
    EmbeddingService,
    SearchProviderService,
    SocialCryptoService,
    UsageService,
    StorageHealthService,
  ],
})
export class InfraModule {}
