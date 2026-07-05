import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

const API_VERSION = '0.1.0';

@ApiTags('meta')
@Controller({ path: 'meta', version: '1' })
export class MetaController {
  @Get('version')
  @ApiOperation({ summary: 'API version and phase information' })
  @ApiOkResponse({ description: 'Version metadata' })
  version() {
    return {
      name: 'spectra-api',
      version: API_VERSION,
      phase: 1,
      documentation: '/docs',
    };
  }
}
