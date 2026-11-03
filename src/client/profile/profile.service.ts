import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../../entities/account.entity';
import { Company } from '../../entities/company.entity';
import { AccountUser } from '../../entities/account-user.entity';
import { AccountStatus, AccountType, AccountUserRole } from '../../entities/enums';
import { TERMS_VERSION } from '../../common/terms';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class ClientProfileService {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(AccountUser)
    private readonly userRepo: Repository<AccountUser>,
  ) {}

  /**
   * Empresa única → multiempresa, desde el panel. Nada se pierde: la empresa actual sigue
   * igual (su sk_, plan y documentos) y la cuenta puede crear más empresas con su ak_.
   * Cada empresa nueva se cobra con su propio plan, por eso se vuelven a aceptar los términos.
   */
  async convertToMulti(accountId: number, userId: number) {
    const account = await this.accountRepo.findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Cuenta no encontrada');

    const user = await this.userRepo.findOne({ where: { id: userId, accountId } });
    if (!user || user.role !== AccountUserRole.ADMIN) {
      throw new ForbiddenException('Solo el administrador de la cuenta puede cambiarla a multiempresa.');
    }
    if (account.type === AccountType.MULTI) {
      throw new BadRequestException('La cuenta ya es multiempresa.');
    }
    if (account.status === AccountStatus.SUSPENDED) {
      throw new ForbiddenException('La cuenta está suspendida. Contacte a soporte.');
    }

    await this.accountRepo.update(accountId, {
      type: AccountType.MULTI,
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
    });
    return this.getProfile(accountId);
  }

  async getProfile(accountId: number) {
    const account = await this.accountRepo.findOne({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }

    const companies = await this.companyRepo.find({
      where: { accountId },
      relations: ['plan', 'emissionPoints', 'docTypes', 'certificates'],
    });

    return { ...account, companies };
  }

  async updateProfile(accountId: number, dto: UpdateProfileDto) {
    const account = await this.accountRepo.findOne({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }

    Object.assign(account, dto);
    return this.accountRepo.save(account);
  }
}
