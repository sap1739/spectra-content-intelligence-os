import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OriginCheckGuard, PermissionsGuard, PrincipalGuard, TenantContextGuard } from './guards';
import { PrincipalService } from './principal.service';
import { SessionService } from './session.service';

/**
 * Authentication + authorization. Guard order matters:
 * origin check (CSRF) → principal resolution → tenant scoping → permissions.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PrincipalService,
    { provide: APP_GUARD, useClass: OriginCheckGuard },
    { provide: APP_GUARD, useClass: PrincipalGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [SessionService, PrincipalService],
})
export class AuthModule {}
