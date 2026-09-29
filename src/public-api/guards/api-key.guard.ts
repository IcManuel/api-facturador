import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from '../../entities/company.entity';
import { CompanyStatus, AccountStatus } from '../../entities/enums';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const apiKey =
      request.headers['x-api-key'] ||
      this.extractBearerToken(request.headers['authorization']);

    if (!apiKey) {
      throw new UnauthorizedException('API key requerida. Envíe X-API-Key o Authorization: Bearer sk_...');
    }

    const company = await this.companyRepo.findOne({
      where: { apiKey, isActive: true },
      relations: ['plan', 'account'],
    });

    if (!company) {
      throw new UnauthorizedException('API key inválida o empresa inactiva');
    }

    if (company.status === CompanyStatus.SUSPENDED) {
      throw new UnauthorizedException('Empresa suspendida. Contacte al administrador.');
    }

    // Check account-level trial/block status
    const account = company.account;
    if (account) {
      if (account.status === AccountStatus.BLOCKED) {
        throw new UnauthorizedException('Cuenta bloqueada. Contacte al administrador.');
      }
      if (account.status === AccountStatus.SUSPENDED) {
        throw new UnauthorizedException('Cuenta suspendida. Contacte al administrador.');
      }
      if (
        account.status === AccountStatus.TRIAL &&
        account.trialEndsAt &&
        new Date() > account.trialEndsAt
      ) {
        throw new UnauthorizedException(
          'Su periodo de prueba de 15 días ha expirado. Contacte al equipo de AutorizadorEC para activar su cuenta.',
        );
      }
    }

    // Attach company to request for downstream use
    request.company = company;
    return true;
  }

  private extractBearerToken(header?: string): string | null {
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token;
  }
}
