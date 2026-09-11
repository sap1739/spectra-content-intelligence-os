import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  reconnectOAuthInputSchema,
  startOAuthInputSchema,
  type ReconnectOAuthInput,
  type StartOAuthInput,
} from '@spectra/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentPrincipal, CurrentTenant, Public, RequirePermissions } from '../../auth/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { Principal, TenantContext } from '../../auth/types';
import { ConnectionsService } from './connections.service';
import { OAuthService } from './oauth.service';

@ApiTags('social')
@Controller({ path: 'workspaces/:workspaceId/social', version: '1' })
export class SocialOAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly connections: ConnectionsService,
  ) {}

  @Get('oauth/platforms')
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary: 'OAuth platform configuration: configured or not, and why. Never a client secret.',
  })
  platforms() {
    return this.connections.listPlatforms();
  }

  @Post('oauth/:platform/start')
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary:
      'Start an OAuth flow. Returns the platform consent URL (state + PKCE). Refused when the platform or credential storage is not configured.',
  })
  start(
    @Param('platform') platform: string,
    @Body(new ZodValidationPipe(startOAuthInputSchema.default({}))) body: StartOAuthInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.oauth.start(tenant, principal, platform, body);
  }

  @Get('connections')
  @RequirePermissions('social:connect')
  @ApiOperation({ summary: 'List OAuth connections (credentials never returned)' })
  list(@CurrentTenant() tenant: TenantContext) {
    return this.connections.list(tenant);
  }

  @Get('connections/:connectionId/capabilities')
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary: 'What a connection can do: granted scopes combined with which adapters are wired',
  })
  capabilities(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.connections.capabilities(tenant, connectionId);
  }

  @Post('connections/:connectionId/refresh')
  @HttpCode(200)
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary:
      'Refresh the access token. Reports REFRESHED, NOT_SUPPORTED, REAUTH_REQUIRED or FAILED.',
  })
  refresh(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.connections.refresh(tenant, principal, connectionId);
  }

  @Post('connections/:connectionId/reconnect')
  @RequirePermissions('social:connect')
  @ApiOperation({ summary: 'Re-authorize a connection; the callback renews it in place' })
  reconnect(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body(new ZodValidationPipe(reconnectOAuthInputSchema.default({}))) body: ReconnectOAuthInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.oauth.startReconnect(tenant, principal, connectionId, body);
  }

  @Delete('connections/:connectionId')
  @HttpCode(200)
  @RequirePermissions('social:connect')
  @ApiOperation({
    summary:
      'Disconnect: asks the platform to revoke (reported honestly), then deletes the stored credential regardless',
  })
  disconnect(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.connections.disconnect(tenant, principal, connectionId);
  }
}

/**
 * The redirect target registered with each platform. Public because the
 * platform sends the browser here: the session is checked inside, so an
 * expired session gets a redirect with an explanation rather than a JSON 401
 * rendered in a browser tab.
 */
@ApiTags('social')
@Public()
@Controller({ path: 'social/oauth', version: '1' })
export class OAuthCallbackController {
  constructor(private readonly oauth: OAuthService) {}

  @Get(':platform/callback')
  @ApiOperation({
    summary:
      'OAuth callback. Always a 302 to the web app with one outcome code — never JSON, never a token.',
  })
  async callback(
    @Param('platform') platform: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const location = await this.oauth.handleCallback({
      platformParam: platform,
      query,
      principal: request.principal ?? null,
    });
    await reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .redirect(location, 302);
  }
}
