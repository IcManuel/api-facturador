import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Account } from '../../entities/account.entity';
import { AccountStatus } from '../../entities/enums';

@Injectable()
export class AccountStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // No user (shouldn't happen after JwtAuthGuard, but be safe)
    if (!user) return true;

    return this.verificarUsuario(request);
  }

  /**
   * Revisa el estado de la cuenta del usuario del panel. Se usa también en las rutas
   * públicas que aceptan el token del panel por su cuenta (JwtOrAccountKeyGuard), para que
   * ninguna ruta del panel se salte el bloqueo.
   */
  async verificarUsuario(request: any): Promise<boolean> {
    const user = request.user;
    if (!user) return true;

    // Platform admins are never blocked
    if (user.role === 'platform_admin') return true;

    // Account users — check account status
    if (user.role === 'account_user' && user.accountId) {
      const account = await this.accountRepo.findOne({ where: { id: user.accountId } });
      if (!account) {
        throw new ForbiddenException('Cuenta no encontrada.');
      }

      if (account.status === AccountStatus.SUSPENDED) {
        throw new ForbiddenException('Su cuenta ha sido suspendida. Contacte al administrador.');
      }

      // Lo único que se puede usar con la cuenta bloqueada por deuda o por la demo vencida, o
      // con el panel bloqueado por mora: ver el cobro, pagar y el perfil.
      const path: string = (request.path ?? request.url ?? '').split('?')[0];
      const rutaDePago = AccountStatusGuard.RUTAS_PAGO.some((r) => r.test(path));

      const demoVencida =
        account.status === AccountStatus.TRIAL && !!account.trialEndsAt && new Date() > account.trialEndsAt;

      if (account.status === AccountStatus.BLOCKED) {
        // Bloqueo decidido por administración: no se desbloquea pagando
        if (account.blockedReason === 'manual') {
          if (/\/client\/billing\/pago\/estado$/.test(path)) return this.attach(request, account);
          throw new ForbiddenException('Su cuenta ha sido bloqueada. Contacte al administrador.');
        }
        if (rutaDePago) return this.attach(request, account);
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PAGO_REQUERIDO',
          message: account.blockedReason === 'demo'
            ? 'Su periodo de prueba terminó. Elija su plan y pague el primer mes para activar la cuenta.'
            : 'Su cuenta está bloqueada por un pago pendiente. Pague para desbloquearla.',
        });
      }

      if (demoVencida) {
        if (rutaDePago) return this.attach(request, account);
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PAGO_REQUERIDO',
          message: 'Su periodo de prueba terminó. Elija su plan y pague el primer mes para activar la cuenta.',
        });
      }

      if (account.paymentLock && !rutaDePago) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PAGO_REQUERIDO',
          message: 'Tiene un pago vencido. El panel se habilita apenas se registre el pago.',
        });
      }

      return this.attach(request, account);
    }

    return true;
  }

  /** Rutas del panel que se pueden usar para pagar (sin el prefijo /api/v1). */
  static readonly RUTAS_PAGO: RegExp[] = [
    /\/client\/billing$/,
    /\/client\/billing\/pago(\/.*)?$/,
    /\/client\/profile$/,
  ];

  private attach(request: any, account: Account): true {
    // Attach account to request for downstream use
    request.account = account;
    return true;
  }
}
