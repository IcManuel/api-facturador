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

    // Platform admins are never blocked
    if (user.role === 'platform_admin') return true;

    // Account users — check account status
    if (user.role === 'account_user' && user.accountId) {
      const account = await this.accountRepo.findOne({ where: { id: user.accountId } });
      if (!account) {
        throw new ForbiddenException('Cuenta no encontrada.');
      }

      if (account.status === AccountStatus.BLOCKED) {
        throw new ForbiddenException('Su cuenta ha sido bloqueada. Contacte al administrador.');
      }

      if (account.status === AccountStatus.SUSPENDED) {
        throw new ForbiddenException('Su cuenta ha sido suspendida. Contacte al administrador.');
      }

      if (
        account.status === AccountStatus.TRIAL &&
        account.trialEndsAt &&
        new Date() > account.trialEndsAt
      ) {
        throw new ForbiddenException(
          'Su periodo de prueba de 15 días ha expirado. Contacte al equipo de AutorizadorEC para activar su cuenta.',
        );
      }

      // Attach account to request for downstream use
      request.account = account;
    }

    return true;
  }
}
