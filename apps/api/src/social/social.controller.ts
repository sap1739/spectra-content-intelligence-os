import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  registerSocialAccountInputSchema,
  validateVariantInputSchema,
  type RegisterSocialAccountInput,
  type ValidateVariantInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SocialService } from './social.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('social')
@Controller({ path: 'workspaces/:workspaceId/social', version: '1' })
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('platforms')
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary: 'Declared platform capabilities + whether a live publisher is wired (none yet)',
  })
  platforms() {
    return this.social.platforms();
  }

  @Post('validate')
  @RequirePermissions('social:connect')
  @ApiOperation({ summary: 'Validate a would-be post against a platform’s declared capabilities' })
  validate(@Body(new ZodValidationPipe(validateVariantInputSchema)) body: ValidateVariantInput) {
    return this.social.validate(body);
  }
}

@ApiTags('social')
@Controller({ path: 'workspaces/:workspaceId/social-accounts', version: '1' })
export class SocialAccountsController {
  constructor(private readonly social: SocialService) {}

  @Get()
  @RequirePermissions('social:connect')
  @ApiOperation({ summary: 'List registered publishing targets (credentials never returned)' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.social.list(tenant);
  }

  @Post()
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary:
      'Register a publishing target (PENDING until verified). Any token is sealed AES-256-GCM.',
  })
  register(
    @Body(new ZodValidationPipe(registerSocialAccountInputSchema)) body: RegisterSocialAccountInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.social.register(tenant, principal, body);
  }

  @Delete(':accountId')
  @HttpCode(204)
  @RequirePermissions('social:connect')
  @ApiOperation({ summary: 'Disconnect a target (soft-delete + purge sealed credential)' })
  async disconnect(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.social.disconnect(tenant, principal, accountId);
  }
}
