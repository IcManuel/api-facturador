import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Company } from '../../entities/company.entity';
import { Certificate } from '../../entities/certificate.entity';
import { Document } from '../../entities/document.entity';
import { EmissionPoint } from '../../entities/emission-point.entity';
import { Account } from '../../entities/account.entity';
import { CertificatesService } from '../../admin/certificates/certificates.service';
import { S3StorageService } from '../../engine/storage/s3.service';
import { AccountType, CompanyEnv, DocStatus } from '../../entities/enums';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UpdateCompanyInfoDto } from './dto/update-company-info.dto';
import { CreateEmissionPointDto } from '../../admin/companies/dto/create-emission-point.dto';
import { UpdateEmissionPointDto } from '../../admin/companies/dto/update-emission-point.dto';

@Injectable()
export class InfoService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(Certificate)
    private readonly certRepo: Repository<Certificate>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(EmissionPoint)
    private readonly emissionPointRepo: Repository<EmissionPoint>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly certificatesService: CertificatesService,
    private readonly s3Service: S3StorageService,
  ) {}

  /* ────────── Información general de la empresa ────────── */

  async updateInfo(company: Company, dto: UpdateCompanyInfoDto) {
    if (Object.keys(dto).length === 0) {
      return this.getCompanyInfo(company);
    }
    const patch: Partial<Company> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.tradeName !== undefined) patch.tradeName = dto.tradeName;
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.address !== undefined) patch.address = dto.address;
    await this.companyRepo.update(company.id, patch);
    const updated = await this.companyRepo.findOne({
      where: { id: company.id },
      relations: ['plan'],
    });
    return this.getCompanyInfo(updated ?? company);
  }

  /**
   * Cambiar el RUC de la empresa. Bloqueado si la empresa ya tiene
   * comprobantes AUTORIZADOS en producción (identidad fiscal locked-in).
   * Sincroniza el RUC de la cuenta para cuentas de empresa única.
   */
  async updateRuc(company: Company, newRuc: string) {
    if (company.ruc === newRuc) {
      return this.getCompanyInfo(company);
    }

    const authorizedProd = await this.docRepo.count({
      where: {
        companyId: company.id,
        status: DocStatus.AUTHORIZED,
        env: CompanyEnv.PRODUCTION,
      },
    });
    if (authorizedProd > 0) {
      throw new ConflictException(
        'No se puede cambiar el RUC: la empresa ya tiene comprobantes autorizados en producción. ' +
          'Contacte a soporte si necesita modificarlo.',
      );
    }

    const clashCompany = await this.companyRepo
      .createQueryBuilder('c')
      .where('c.ruc = :ruc AND c.id <> :id', { ruc: newRuc, id: company.id })
      .getOne();
    if (clashCompany) {
      throw new ConflictException(`Ya existe una empresa registrada con el RUC ${newRuc}.`);
    }

    await this.companyRepo.update(company.id, { ruc: newRuc });

    const account = await this.accountRepo.findOne({ where: { id: company.accountId } });
    if (account && account.type === AccountType.SINGLE && account.ruc !== newRuc) {
      const accountRucTaken = await this.accountRepo
        .createQueryBuilder('a')
        .where('a.ruc = :ruc AND a.id <> :id', { ruc: newRuc, id: account.id })
        .getOne();
      if (!accountRucTaken) {
        await this.accountRepo.update(account.id, { ruc: newRuc });
      }
    }

    const updated = await this.companyRepo.findOne({
      where: { id: company.id },
      relations: ['plan'],
    });
    return this.getCompanyInfo(updated ?? company);
  }

  /* ────────── Logo (para el RIDE/PDF) ────────── */

  async uploadLogo(company: Company, buffer: Buffer, mimeType: string) {
    if (company.logoS3Key) {
      await this.s3Service.deleteLogo(company.logoS3Key).catch(() => {});
    }
    const result = await this.s3Service.uploadLogo(company.ruc, buffer, mimeType);
    await this.companyRepo.update(company.id, { logoS3Key: result.s3Key });
    return { logoS3Key: result.s3Key, message: 'Logo actualizado. Aparecerá en los próximos comprobantes (RIDE).' };
  }

  async deleteLogo(company: Company) {
    if (company.logoS3Key) {
      await this.s3Service.deleteLogo(company.logoS3Key).catch(() => {});
      await this.companyRepo.update(company.id, { logoS3Key: null as any });
    }
    return { message: 'Logo eliminado.' };
  }

  async getLogo(companyId: number): Promise<{ buffer: Buffer; contentType: string } | null> {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company?.logoS3Key) return null;
    const buffer = await this.s3Service.download(company.logoS3Key);
    const contentType = company.logoS3Key.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return { buffer, contentType };
  }

  /* ────────── Emission Points ────────── */

  async listEmissionPoints(companyId: number) {
    const points = await this.emissionPointRepo.find({
      where: { companyId },
      order: { code: 'ASC' },
    });
    return points.map((ep) => ({
      id: ep.id,
      code: ep.code,
      description: ep.description ?? null,
      isActive: ep.isActive,
    }));
  }

  async createEmissionPoint(companyId: number, dto: CreateEmissionPointDto) {
    if (!/^\d{3}$/.test(dto.code)) {
      throw new BadRequestException('El código del punto de emisión debe ser de 3 dígitos numéricos.');
    }
    const exists = await this.emissionPointRepo.findOne({
      where: { companyId, code: dto.code },
    });
    if (exists) {
      throw new ConflictException(`Ya existe un punto de emisión con el código ${dto.code}.`);
    }
    const ep = await this.emissionPointRepo.save(
      this.emissionPointRepo.create({
        companyId,
        code: dto.code,
        description: dto.description,
      }),
    );
    return { id: ep.id, code: ep.code, description: ep.description ?? null, isActive: ep.isActive };
  }

  async updateEmissionPoint(companyId: number, empId: number, dto: UpdateEmissionPointDto) {
    const ep = await this.emissionPointRepo.findOne({ where: { id: empId, companyId } });
    if (!ep) {
      throw new NotFoundException(`Punto de emisión ${empId} no encontrado.`);
    }
    if (dto.code !== undefined && dto.code !== ep.code) {
      if (!/^\d{3}$/.test(dto.code)) {
        throw new BadRequestException('El código del punto de emisión debe ser de 3 dígitos numéricos.');
      }
      const clash = await this.emissionPointRepo.findOne({ where: { companyId, code: dto.code } });
      if (clash) throw new ConflictException(`Ya existe un punto de emisión con el código ${dto.code}.`);
      ep.code = dto.code;
    }
    if (dto.description !== undefined) ep.description = dto.description as any;
    if (dto.isActive !== undefined) ep.isActive = dto.isActive;
    await this.emissionPointRepo.save(ep);
    return { id: ep.id, code: ep.code, description: ep.description ?? null, isActive: ep.isActive };
  }

  async deleteEmissionPoint(companyId: number, empId: number) {
    const ep = await this.emissionPointRepo.findOne({ where: { id: empId, companyId } });
    if (!ep) {
      throw new NotFoundException(`Punto de emisión ${empId} no encontrado.`);
    }
    const total = await this.emissionPointRepo.count({ where: { companyId } });
    if (total <= 1) {
      throw new ConflictException('La empresa debe tener al menos un punto de emisión.');
    }
    await this.emissionPointRepo.delete({ id: empId, companyId });
    return { message: `Punto de emisión ${ep.code} eliminado.` };
  }

  getCompanyInfo(company: Company) {
    return {
      id: company.id,
      name: company.name,
      tradeName: company.tradeName,
      ruc: company.ruc,
      environment: company.env,
      status: company.status,
      establishment: company.establishment,
      plan: company.plan ? {
        name: company.plan.name,
        tier: company.plan.tier,
        docLimit: company.plan.docLimit,
      } : null,
      overageEnabled: company.overageEnabled,
      timezone: company.timezone,
    };
  }

  async getCertificateInfo(companyId: number) {
    const cert = await this.certRepo.findOne({
      where: { companyId, isCurrent: true },
    });

    if (!cert) {
      return { hasCertificate: false, certificate: null };
    }

    const now = new Date();
    const expiresAt = cert.expiresAt ? new Date(cert.expiresAt) : null;
    const daysUntilExpiry = expiresAt
      ? Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      hasCertificate: true,
      certificate: {
        id: cert.id,
        subjectCn: cert.subjectCn,
        expiresAt: cert.expiresAt,
        daysUntilExpiry,
        isExpired: daysUntilExpiry !== null && daysUntilExpiry <= 0,
        isExpiringSoon: daysUntilExpiry !== null && daysUntilExpiry <= 30,
        uploadedAt: cert.uploadedAt,
      },
    };
  }

  /** Free test documents per month for all plans */
  static readonly TEST_DOC_LIMIT = 50;

  async getUsageInfo(company: Company) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const baseQuery = () =>
      this.docRepo
        .createQueryBuilder('d')
        .where('d.companyId = :companyId', { companyId: company.id })
        .andWhere('d.createdAt >= :start', { start: startOfMonth })
        .andWhere('d.createdAt < :end', { end: endOfMonth });

    const [prodTotal, prodAuthorized, testTotal] = await Promise.all([
      baseQuery().andWhere('d.env = :env', { env: 'production' }).getCount(),
      baseQuery().andWhere('d.env = :env', { env: 'production' }).andWhere('d.status = :status', { status: 'AUTHORIZED' }).getCount(),
      baseQuery().andWhere('d.env = :env', { env: 'test' }).getCount(),
    ]);

    const plan = company.plan;
    const docLimit = plan?.docLimit ?? null;
    const overageEnabled = company.overageEnabled;
    const testLimit = company.testDocLimit ?? InfoService.TEST_DOC_LIMIT;

    return {
      period: {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
      },
      production: {
        docsTotal: prodTotal,
        docsAuthorized: prodAuthorized,
        remaining: docLimit ? Math.max(0, docLimit - prodTotal) : null,
        overLimit: docLimit ? prodTotal > docLimit : false,
        overageDocs: docLimit ? Math.max(0, prodTotal - docLimit) : 0,
      },
      test: {
        docsTotal: testTotal,
        limit: testLimit,
        remaining: Math.max(0, testLimit - testTotal),
      },
      plan: plan ? {
        name: plan.name,
        tier: plan.tier,
        docLimit,
        overageEnabled,
      } : null,
    };
  }

  // ── Self-management methods ──

  async updateEnvironment(companyId: number, env: CompanyEnv) {
    await this.companyRepo.update(companyId, { env });
    return { environment: env };
  }

  async updateSettings(companyId: number, dto: UpdateSettingsDto) {
    await this.companyRepo.update(companyId, dto as any);
    const company = await this.companyRepo.findOneByOrFail({ id: companyId });
    return {
      webhookUrl: company.webhookUrl,
      webhookSecret: company.webhookSecret ? '••••••' : null,
      notifyClient: company.notifyClient,
      notifyCompany: company.notifyCompany,
      notificationEmail: company.notificationEmail,
    };
  }

  async uploadCertificate(
    companyId: number,
    fileBuffer: Buffer,
    fileName: string,
    password: string,
  ) {
    return this.certificatesService.upload(companyId, fileBuffer, fileName, password, null);
  }

  async regenerateApiKey(companyId: number) {
    const apiKey = 'sk_' + randomBytes(32).toString('hex');
    await this.companyRepo.update(companyId, { apiKey });
    return { apiKey };
  }
}
