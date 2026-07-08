import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  loginRequestSchema,
  registerRequestSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@spectra/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { getApiEnv } from '../config/env';
import { CurrentPrincipal, Public } from './decorators';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from './session.service';
import type { Principal } from './types';

function sessionCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: getApiEnv().NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS,
  };
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account with a first organization and workspace' })
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const correlationId = request.headers['x-correlation-id'] as string | undefined;
    const { sessionId, principal } = await this.auth.register(body, correlationId);
    reply.setCookie(SESSION_COOKIE, sessionId, sessionCookieOptions());
    return this.auth.me(principal);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate with email and password' })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const correlationId = request.headers['x-correlation-id'] as string | undefined;
    const { sessionId, principal } = await this.auth.login(body, correlationId, request.ip);
    reply.setCookie(SESSION_COOKIE, sessionId, sessionCookieOptions());
    return this.auth.me(principal);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Destroy the current session' })
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if (sessionId) {
      await this.auth.logout(sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  @ApiOperation({ summary: 'Current user, memberships and accessible workspaces' })
  async me(@CurrentPrincipal() principal: Principal) {
    return this.auth.me(principal);
  }
}
