import {
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Permission } from '@spectra/contracts';
import type { FastifyRequest } from 'fastify';

import type { Principal, TenantContext } from './types';

export const IS_PUBLIC_KEY = 'spectra:isPublic';
/** Marks a route as reachable without authentication (health, auth itself). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'spectra:permissions';
/** Declares the permissions required to call a tenant-scoped route. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.principal) {
      throw new UnauthorizedException('Authentication required');
    }
    return request.principal;
  },
);

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.tenant) {
      // Programming error: route used @CurrentTenant without tenant params.
      throw new UnauthorizedException('Tenant scope not resolved for this route');
    }
    return request.tenant;
  },
);
