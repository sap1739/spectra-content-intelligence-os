import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createPodcastEpisodeInputSchema,
  createVoiceProfileInputSchema,
  recordVoiceConsentInputSchema,
  revokeVoiceConsentInputSchema,
  startAudioRenderInputSchema,
  updatePodcastEpisodeInputSchema,
  type CreatePodcastEpisodeInput,
  type CreateVoiceProfileInput,
  type RecordVoiceConsentInput,
  type RevokeVoiceConsentInput,
  type StartAudioRenderInput,
  type UpdatePodcastEpisodeInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AudioService } from './audio.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('audio')
@Controller({ path: 'workspaces/:workspaceId/audio', version: '1' })
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  @Get('capabilities')
  @RequirePermissions('audio:read')
  @ApiOperation({
    summary:
      'What this deployment can do with audio — and that nothing here generates speech or music',
  })
  capabilities() {
    return this.audio.capabilities();
  }

  @Get('voices')
  @RequirePermissions('audio:read')
  @ApiOperation({ summary: 'Voices in this workspace, each with its live consent verdict' })
  listVoices(@CurrentTenant() tenant: TenantContext) {
    return this.audio.listVoices(tenant);
  }

  @Get('voices/:voiceId')
  @RequirePermissions('audio:read')
  @ApiOperation({ summary: 'One voice and its full consent history' })
  getVoice(@Param('voiceId', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.audio.getVoice(tenant, id);
  }

  @Post('voices')
  @HttpCode(201)
  @RequirePermissions('audio:write')
  @ApiOperation({ summary: 'Create a voice; a cloned voice must name the person it imitates' })
  createVoice(
    @Body(new ZodValidationPipe(createVoiceProfileInputSchema)) body: CreateVoiceProfileInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.createVoice(tenant, principal, body);
  }

  @Post('voices/:voiceId/consent')
  @HttpCode(201)
  @RequirePermissions('voice:consent')
  @ApiOperation({
    summary: 'Record a person’s consent to their voice being used, for what and until when',
  })
  recordConsent(
    @Param('voiceId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(recordVoiceConsentInputSchema)) body: RecordVoiceConsentInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.recordConsent(tenant, principal, id, body);
  }

  @Post('voices/:voiceId/consent/:consentId/revoke')
  @RequirePermissions('voice:consent')
  @ApiOperation({ summary: 'Revoke consent; takes effect on renders already queued' })
  revokeConsent(
    @Param('voiceId', ParseUUIDPipe) voiceId: string,
    @Param('consentId', ParseUUIDPipe) consentId: string,
    @Body(new ZodValidationPipe(revokeVoiceConsentInputSchema)) body: RevokeVoiceConsentInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.revokeConsent(tenant, principal, voiceId, consentId, body);
  }

  @Get('episodes')
  @RequirePermissions('audio:read')
  @ApiOperation({ summary: 'Podcast episodes in this workspace, newest first' })
  listEpisodes(@CurrentTenant() tenant: TenantContext) {
    return this.audio.listEpisodes(tenant);
  }

  @Get('episodes/:episodeId')
  @RequirePermissions('audio:read')
  @ApiOperation({ summary: 'One episode, its renders, transcripts and per-voice consent state' })
  getEpisode(
    @Param('episodeId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
  ) {
    return this.audio.getEpisode(tenant, id);
  }

  @Post('episodes')
  @HttpCode(201)
  @RequirePermissions('audio:write')
  @ApiOperation({ summary: 'Create an episode; the script is planned before it is stored' })
  createEpisode(
    @Body(new ZodValidationPipe(createPodcastEpisodeInputSchema)) body: CreatePodcastEpisodeInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.createEpisode(tenant, principal, body);
  }

  @Patch('episodes/:episodeId')
  @RequirePermissions('audio:write')
  @ApiOperation({ summary: 'Edit an episode; finished renders keep their own script snapshot' })
  updateEpisode(
    @Param('episodeId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePodcastEpisodeInputSchema)) body: UpdatePodcastEpisodeInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.updateEpisode(tenant, principal, id, body);
  }

  @Delete('episodes/:episodeId')
  @RequirePermissions('audio:write')
  @ApiOperation({ summary: 'Archive an episode' })
  archiveEpisode(
    @Param('episodeId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.archiveEpisode(tenant, principal, id);
  }

  @Post('episodes/:episodeId/renders')
  @HttpCode(202)
  @RequirePermissions('audio:write')
  @ApiOperation({
    summary: 'Queue a mix — consent-, capability- and budget-checked before the job exists',
  })
  startRender(
    @Param('episodeId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(startAudioRenderInputSchema)) body: StartAudioRenderInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.startRender(tenant, principal, id, body);
  }

  @Get('renders/:renderId')
  @RequirePermissions('audio:read')
  @ApiOperation({ summary: 'A render’s status, progress and — if it failed — why' })
  getRender(@Param('renderId', ParseUUIDPipe) id: string, @CurrentTenant() tenant: TenantContext) {
    return this.audio.getRender(tenant, id);
  }

  @Post('renders/:renderId/cancel')
  @RequirePermissions('audio:write')
  @ApiOperation({ summary: 'Cancel a queued or running render' })
  cancelRender(
    @Param('renderId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audio.cancelRender(tenant, principal, id);
  }

  @Get('renders/:renderId/url')
  @RequirePermissions('audio:read')
  @ApiOperation({ summary: 'A 15-minute signed URL for the episode audio or its waveform' })
  renderUrl(
    @Param('renderId', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @Query('file') file?: string,
  ) {
    return this.audio.renderUrl(tenant, id, file === 'waveform' ? 'waveform' : 'audio');
  }
}
