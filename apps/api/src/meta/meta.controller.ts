import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators';

const API_VERSION = '0.2.0';

@ApiTags('meta')
@Public()
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
