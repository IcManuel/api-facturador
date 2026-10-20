import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Type,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export const PLATFORM_ADMIN = 'platform_admin';

/** ¿El controlador cuelga de "admin/..."? (sin depender del prefijo global /api/v1). */
export function isAdminController(controller: Type<unknown>): boolean {
  const raw = Reflect.getMetadata(PATH_METADATA, controller) as
    | string
    | string[]
    | undefined;
  const paths = Array.isArray(raw) ? raw : [raw ?? ''];
  return paths.some((p) => {
    const path = p.replace(/^\/+/, '');
    return path === 'admin' || path.startsWith('admin/');
  });
}

/**
 * Guard global de roles. Va después de JwtAuthGuard (que ya dejó el usuario en la request).
 *
 * - Respeta @Roles(...) en el handler o el controlador.
 * - Todo controlador bajo "admin/..." exige platform_admin aunque no tenga @Roles, para que
 *   un endpoint de administración nuevo nunca quede abierto a los clientes por olvido.
 * - Las rutas @Public() no se tocan.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    let requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles?.length && isAdminController(context.getClass())) {
      requiredRoles = [PLATFORM_ADMIN];
    }
    if (!requiredRoles?.length) return true;

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: { role?: string } }>();
    if (!user?.role || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        'No tiene permisos para acceder a esta sección.',
      );
    }
    return true;
  }
}
