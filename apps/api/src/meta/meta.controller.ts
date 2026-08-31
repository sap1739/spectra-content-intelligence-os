import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AiTextService } from '../infra/ai.service';
import { EmbeddingService } from '../infra/embedding.service';
import { SearchProviderService } from '../infra/search.service';
import { SocialCryptoService } from '../infra/social-crypto.service';
import { Public } from '../auth/decorators';

const API_VERSION = '0.5.0';
/** Current delivery phase — keep in step with docs/ROADMAP.md. */
const PHASE = 5;

@ApiTags('meta')
@Controller({ path: 'meta', version: '1' })
export class MetaController {
  constructor(
    private readonly ai: AiTextService,
    private readonly embeddings: EmbeddingService,
    private readonly search: SearchProviderService,
    private readonly crypto: SocialCryptoService,
  ) {}

  @Get('version')
  @Public()
  @ApiOperation({ summary: 'API version and phase information' })
  @ApiOkResponse({ description: 'Version metadata' })
  version() {
    return {
      name: 'spectra-api',
      version: API_VERSION,
      phase: PHASE,
      documentation: '/docs',
    };
  }

  /**
   * One honest answer to "what is actually wired?". Every integration here is
   * env-gated; this reports what can really run right now, so the UI never
   * implies a capability the deployment does not have. Authenticated: it
   * describes deployment configuration, not public metadata.
   */
  @Get('capabilities')
  @ApiOperation({
    summary: 'Which env-gated integrations are actually live in this deployment',
  })
  capabilities() {
    return {
      generation: this.ai.status(),
      retrieval: this.embeddings.status(),
      discovery: this.search.status(),
      credentialStorage: {
        configured: this.crypto.isConfigured,
        note: this.crypto.isConfigured
          ? 'Social credentials can be sealed and stored (AES-256-GCM).'
          : 'SOCIAL_TOKEN_ENCRYPTION_KEY is not set — credentials cannot be stored, and publishing resolves to UNSUPPORTED.',
      },
    };
  }
}
