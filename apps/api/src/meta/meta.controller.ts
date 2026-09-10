import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AiTextService } from '../infra/ai.service';
import { EmbeddingService } from '../infra/embedding.service';
import { SearchProviderService } from '../infra/search.service';
import { SocialCryptoService } from '../infra/social-crypto.service';
import { Public } from '../auth/decorators';
import { CONTENT_TYPE_FORMAT, PROMPT_TEMPLATE_ID, PROMPT_VERSION } from '@spectra/content-pipeline';
import { metrics } from '@spectra/telemetry';

const API_VERSION = '0.6.0';
/** Current delivery phase — keep in step with docs/ROADMAP.md. */
const PHASE = 6;

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
      // Templates (Phase 6A): report what genuinely exists — ONE built-in,
      // versioned prompt template. There is no user-editable template store,
      // and saying so is better than a page implying one is coming.
      templates: {
        userEditable: false,
        builtIn: [
          {
            id: PROMPT_TEMPLATE_ID,
            version: PROMPT_VERSION,
            kind: 'PROMPT',
            displayName: 'Evidence-grounded draft',
            description:
              'The prompt used for every generated draft: trusted operator/brand guidance as instructions, evidence wrapped as untrusted data, strict citation rules.',
          },
        ],
        contentTypeFormats: CONTENT_TYPE_FORMAT,
        note: 'Every generated draft records which prompt template and version produced it, so content remains attributable. Visual and user-defined templates are not implemented.',
      },
      credentialStorage: {
        configured: this.crypto.isConfigured,
        note: this.crypto.isConfigured
          ? 'Social credentials can be sealed and stored (AES-256-GCM).'
          : 'SOCIAL_TOKEN_ENCRYPTION_KEY is not set — credentials cannot be stored, and publishing resolves to UNSUPPORTED.',
      },
    };
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @Public()
  @ApiOperation({
    summary: 'Prometheus metrics exposition',
    description:
      'Counters, histograms and gauges for API, worker, queue, provider and budget activity. Contains no tenant content — only opaque ids, route patterns and counts.',
  })
  async metrics(): Promise<string> {
    return metrics.render();
  }
}
