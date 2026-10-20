import { Controller, ForbiddenException, Get, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RolesGuard, isAdminController, PLATFORM_ADMIN } from './roles.guard';
import { Roles, ROLES_KEY } from '../decorators/roles.decorator';
import { Public } from '../decorators/public.decorator';

const CLIENT = {
  id: 1,
  email: 'cliente@x.com',
  role: 'account_user',
  accountId: 1,
};
const ADMIN = { id: 1, email: 'admin@x.com', role: 'platform_admin' };

function ctx(cls: Function, handler: Function, user: unknown) {
  return {
    getType: () => 'http',
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

const guard = new RolesGuard(new Reflector());
const allows = (cls: Function, handler: Function, user: unknown) => {
  try {
    return guard.canActivate(ctx(cls, handler, user));
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
};

// ── Controladores de ejemplo ──
@Controller('admin/ejemplo')
class AdminSinRoles {
  @Get() listar() {}
}
@Controller('client/ejemplo')
class ClienteCtrl {
  @Get() listar() {}
  @Roles(PLATFORM_ADMIN) @Get('solo-admin') soloAdmin() {}
}
@Controller('admin/publico')
class AdminConPublico {
  @Public() @Get() abierto() {}
}

describe('RolesGuard', () => {
  it('un cliente recibe 403 en admin/* aunque el controlador no tenga @Roles', () => {
    expect(() =>
      guard.canActivate(
        ctx(AdminSinRoles, AdminSinRoles.prototype.listar, CLIENT),
      ),
    ).toThrow(
      new ForbiddenException('No tiene permisos para acceder a esta sección.'),
    );
  });

  it('el administrador entra a admin/*', () => {
    expect(allows(AdminSinRoles, AdminSinRoles.prototype.listar, ADMIN)).toBe(
      true,
    );
  });

  it('sin usuario en la request, admin/* se rechaza', () => {
    expect(
      allows(AdminSinRoles, AdminSinRoles.prototype.listar, undefined),
    ).toBe(false);
  });

  it('las rutas de cliente siguen abiertas para el cliente', () => {
    expect(allows(ClienteCtrl, ClienteCtrl.prototype.listar, CLIENT)).toBe(
      true,
    );
  });

  it('@Roles se respeta también fuera de admin/*', () => {
    expect(allows(ClienteCtrl, ClienteCtrl.prototype.soloAdmin, CLIENT)).toBe(
      false,
    );
    expect(allows(ClienteCtrl, ClienteCtrl.prototype.soloAdmin, ADMIN)).toBe(
      true,
    );
  });

  it('las rutas @Public() no exigen rol', () => {
    expect(
      allows(AdminConPublico, AdminConPublico.prototype.abierto, undefined),
    ).toBe(true);
  });

  it('no interfiere con contextos que no son HTTP (websocket)', () => {
    const wsCtx = {
      ...ctx(AdminSinRoles, AdminSinRoles.prototype.listar, CLIENT),
      getType: () => 'ws',
    };
    expect(guard.canActivate(wsCtx)).toBe(true);
  });

  it('reconoce "admin" con o sin barra inicial y no confunde rutas parecidas', () => {
    @Controller('/admin/x')
    class A {}
    @Controller('administracion')
    class B {}
    @Controller('client/admin')
    class C {}
    expect(isAdminController(A)).toBe(true);
    expect(isAdminController(B)).toBe(false);
    expect(isAdminController(C)).toBe(false);
  });
});

// ── Cobertura real: TODOS los controladores de src/admin y cada uno de sus endpoints ──
function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

const adminControllers = controllerFiles(
  join(__dirname, '..', '..', 'admin'),
).flatMap((file) =>
  Object.values(require(file) as Record<string, unknown>)
    .filter(
      (v): v is Type<unknown> =>
        typeof v === 'function' && Reflect.hasMetadata(PATH_METADATA, v),
    )
    .map((cls) => ({ file, cls })),
);

describe('Todos los endpoints de admin/* exigen platform_admin', () => {
  it('se encontraron los controladores de administración', () => {
    expect(adminControllers.length).toBeGreaterThanOrEqual(12);
  });

  for (const { cls } of adminControllers) {
    const base = Reflect.getMetadata(PATH_METADATA, cls);
    const handlers = Object.getOwnPropertyNames(cls.prototype)
      .filter((m) => m !== 'constructor')
      .map((m) => (cls.prototype as any)[m])
      .filter(
        (fn) =>
          typeof fn === 'function' && Reflect.hasMetadata(METHOD_METADATA, fn),
      );

    describe(`${cls.name} (${base})`, () => {
      it('está bajo admin/ y marcado con @Roles(platform_admin)', () => {
        expect(isAdminController(cls)).toBe(true);
        expect(Reflect.getMetadata(ROLES_KEY, cls)).toEqual([PLATFORM_ADMIN]);
        expect(handlers.length).toBeGreaterThan(0);
      });

      for (const h of handlers) {
        const route =
          `${base}/${Reflect.getMetadata(PATH_METADATA, h)}`.replace(
            /\/+$/,
            '',
          );
        it(`${route}: cliente → 403, admin → pasa`, () => {
          expect(allows(cls, h, CLIENT)).toBe(false);
          expect(allows(cls, h, ADMIN)).toBe(true);
        });
      }
    });
  }
});
