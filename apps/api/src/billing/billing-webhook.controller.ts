import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { BillingProviderError } from '@spectra/billing-core';
import type { FastifyRequest } from 'fastify';

import { Public } from '../auth/decorators';
import { BillingService } from './billing.service';

/**
 * The provider's webhook endpoint.
 *
 * Deliberately outside the tenanted routes and outside session auth: Stripe
 * has no session. Its **signature is the authentication**, verified against
 * the raw request body before a single field is read.
 *
 * The raw body matters. A parsed-then-re-serialized object will not match the
 * signature, so `bootstrap.ts` registers a content-type parser that keeps the
 * bytes for this path alone.
 */
@Controller({ path: 'billing/webhook', version: '1' })
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('stripe')
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async stripe(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    const raw = request.rawBody;
    if (!raw) {
      // Without the raw bytes the signature cannot be checked, so the request
      // is refused rather than processed on trust.
      throw new BillingProviderError(
        'NO_RAW_BODY',
        'The webhook body was not captured in raw form, so its signature cannot be verified.',
      );
    }
    const result = await this.billing.handleWebhook(raw, signature ?? '');
    // 200 with a body the provider ignores: anything else makes Stripe retry.
    return result;
  }
}
