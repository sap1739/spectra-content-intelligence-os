import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCheckoutSessionInputSchema,
  grantCreditsInputSchema,
  type CreateCheckoutSessionInput,
  type GrantCreditsInput,
} from '@spectra/contracts';

import { CurrentPrincipal, CurrentTenant, RequirePermissions } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BillingService } from './billing.service';
import type { Principal, TenantContext } from '../auth/types';

@ApiTags('billing')
@Controller({ path: 'organizations/:organizationId/billing', version: '1' })
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('capabilities')
  @RequirePermissions('billing:read')
  @ApiOperation({
    summary: 'Whether billing is configured — and that usage figures are estimates, not invoices',
  })
  capabilities() {
    return this.billing.capabilities();
  }

  @Get('plans')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'Plans, their entitlements, and which can actually be purchased' })
  plans() {
    return this.billing.listPlans();
  }

  @Get('subscription')
  @RequirePermissions('billing:read')
  @ApiOperation({
    summary: 'The subscription as Spectra mirrors it from the provider — never from the browser',
  })
  subscription(@CurrentTenant() tenant: TenantContext) {
    return this.billing.getSubscription(tenant);
  }

  @Get('entitlements')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'Every plan limit with its current usage' })
  entitlements(@CurrentTenant() tenant: TenantContext) {
    return this.billing.entitlements(tenant);
  }

  @Get('credits')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'Credit balance, what is expiring, and the grants behind it' })
  credits(@CurrentTenant() tenant: TenantContext) {
    return this.billing.creditBalance(tenant);
  }

  @Post('checkout')
  @HttpCode(201)
  @RequirePermissions('org:billing:manage')
  @ApiOperation({
    summary: 'Create a Stripe Checkout session; card entry happens on Stripe, never here',
  })
  checkout(
    @Body(new ZodValidationPipe(createCheckoutSessionInputSchema)) body: CreateCheckoutSessionInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.createCheckoutSession(tenant, principal, body);
  }

  @Post('portal')
  @HttpCode(201)
  @RequirePermissions('org:billing:manage')
  @ApiOperation({ summary: 'Open the provider’s customer portal to manage or cancel a plan' })
  portal(@CurrentTenant() tenant: TenantContext, @CurrentPrincipal() principal: Principal) {
    return this.billing.createPortalSession(tenant, principal);
  }

  @Post('credits/grant')
  @HttpCode(201)
  @RequirePermissions('org:billing:manage')
  @ApiOperation({ summary: 'Grant credits by hand — goodwill, or an enterprise agreement' })
  grantCredits(
    @Body(new ZodValidationPipe(grantCreditsInputSchema)) body: GrantCreditsInput,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.grantCredits(tenant, principal, body);
  }
}
