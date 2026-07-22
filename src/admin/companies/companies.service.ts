import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomBytes } from 'crypto';

import { Company } from '../../entities/company.entity';
import { EmissionPoint } from '../../entities/emission-point.entity';
import { CompanyDocType } from '../../entities/company-doc-type.entity';
import { CompanySeries } from '../../entities/company-series.entity';
import { CompanyStatus, SriDocTypeCode } from '../../entities/enums';
import { S3StorageService } from '../../engine/storage/s3.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { CreateEmissionPointDto } from './dto/create-emission-point.dto';
import { UpdateEmissionPointDto } from './dto/update-emission-point.dto';
import { SetSequentialDto } from './dto/set-sequential.dto';

@Injectable()
export class CompaniesService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(EmissionPoint)
    private readonly emissionPointRepo: Repository<EmissionPoint>,
    @InjectRepository(CompanyDocType)
    private readonly companyDocTypeRepo: Repository<CompanyDocType>,
    @InjectRepository(CompanySeries)
    private readonly companySeriesRepo: Repository<CompanySeries>,
    private readonly dataSource: DataSource,
    private readonly s3Service: S3StorageService,
  ) {}

  async findAll(
    page: number,
    limit: number,
    search?: string,
    accountId?: number,
    status?: CompanyStatus,
  ) {
    const qb = this.companyRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.account', 'account')
      .leftJoinAndSelect('c.plan', 'plan')
      .leftJoinAndSelect('c.emissionPoints', 'emissionPoints')
      .leftJoinAndSelect('c.docTypes', 'docTypes');

    if (search) {
      qb.andWhere('(c.name ILIKE :search OR c.ruc ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (accountId) {
      qb.andWhere('c.accountId = :accountId', { accountId });
    }

    if (status) {
      qb.andWhere('c.status = :status', { status });
    }

    qb.orderBy('c.createdAt', 'DESC');

    const skip = (page - 1) * limit;
    qb.skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Monthly activity report: for each company, count docs per month of the
   * given year (total + authorized), plus the yearly total and monthly average.
   * Sorted by total docs desc.
   */
  async getMonthlyActivity(year: number, env: 'production' | 'test' | 'all') {
    const envFilter =
      env === 'production' ? ` AND d.doc_env = 'production'`
      : env === 'test' ? ` AND d.doc_env = 'test'`
      : '';

    const rows = await this.companyRepo.manager.query<Array<{
      com_id: number;
      com_name: string;
      com_ruc: string;
      acc_id: number;
      acc_name: string;
      m01: string; m02: string; m03: string; m04: string; m05: string; m06: string;
      m07: string; m08: string; m09: string; m10: string; m11: string; m12: string;
      a01: string; a02: string; a03: string; a04: string; a05: string; a06: string;
      a07: string; a08: string; a09: string; a10: string; a11: string; a12: string;
      total: string;
      total_authorized: string;
    }>>(
      `
      SELECT
        c.com_id, c.com_name, c.com_ruc, a.acc_id, a.acc_name,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=1)  AS m01,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=2)  AS m02,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=3)  AS m03,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=4)  AS m04,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=5)  AS m05,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=6)  AS m06,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=7)  AS m07,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=8)  AS m08,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=9)  AS m09,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=10) AS m10,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=11) AS m11,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=12) AS m12,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=1  AND d.doc_status='AUTHORIZED') AS a01,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=2  AND d.doc_status='AUTHORIZED') AS a02,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=3  AND d.doc_status='AUTHORIZED') AS a03,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=4  AND d.doc_status='AUTHORIZED') AS a04,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=5  AND d.doc_status='AUTHORIZED') AS a05,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=6  AND d.doc_status='AUTHORIZED') AS a06,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=7  AND d.doc_status='AUTHORIZED') AS a07,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=8  AND d.doc_status='AUTHORIZED') AS a08,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=9  AND d.doc_status='AUTHORIZED') AS a09,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=10 AND d.doc_status='AUTHORIZED') AS a10,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=11 AND d.doc_status='AUTHORIZED') AS a11,
        COUNT(d.doc_id) FILTER (WHERE EXTRACT(MONTH FROM d.doc_created_at)=12 AND d.doc_status='AUTHORIZED') AS a12,
        COUNT(d.doc_id) AS total,
        COUNT(d.doc_id) FILTER (WHERE d.doc_status='AUTHORIZED') AS total_authorized
      FROM app.company c
      JOIN app.account a ON a.acc_id = c.acc_id
      LEFT JOIN app.document d
             ON d.com_id = c.com_id
            AND EXTRACT(YEAR FROM d.doc_created_at) = $1
            ${envFilter}
      GROUP BY c.com_id, c.com_name, c.com_ruc, a.acc_id, a.acc_name
      ORDER BY total DESC, c.com_name ASC;
      `,
      [year],
    );

    return {
      year,
      env,
      companies: rows.map((r) => {
        const monthly = [r.m01, r.m02, r.m03, r.m04, r.m05, r.m06, r.m07, r.m08, r.m09, r.m10, r.m11, r.m12].map(Number);
        const monthlyAuthorized = [r.a01, r.a02, r.a03, r.a04, r.a05, r.a06, r.a07, r.a08, r.a09, r.a10, r.a11, r.a12].map(Number);
        const total = Number(r.total);
        const totalAuthorized = Number(r.total_authorized);
        const activeMonths = monthly.filter((n) => n > 0).length;
        return {
          companyId: Number(r.com_id),
          companyName: r.com_name,
          ruc: r.com_ruc,
          accountId: Number(r.acc_id),
          accountName: r.acc_name,
          monthly,
          monthlyAuthorized,
          total,
          totalAuthorized,
          monthlyAverage: activeMonths > 0 ? Number((total / activeMonths).toFixed(1)) : 0,
        };
      }),
    };
  }

  async findOne(id: number): Promise<Company> {
    const company = await this.companyRepo.findOne({
      where: { id },
      relations: ['account', 'plan', 'emissionPoints', 'docTypes', 'certificates'],
    });

    if (!company) {
      throw new NotFoundException(`Empresa con ID ${id} no encontrada`);
    }

    return company;
  }

  async create(dto: CreateCompanyDto): Promise<Company> {
    const exists = await this.companyRepo.findOne({ where: { ruc: dto.ruc } });
    if (exists) {
      throw new ConflictException(`Ya existe una empresa con RUC ${dto.ruc}`);
    }

    const apiKey = 'sk_' + randomBytes(32).toString('hex');

    const company = this.companyRepo.create({
      ...dto,
      apiKey,
      billingStartDate: dto.billingStartDate ?? new Date().toISOString().slice(0, 10),
    });

    return this.companyRepo.save(company);
  }

  async update(id: number, dto: UpdateCompanyDto): Promise<Company> {
    const company = await this.findOne(id);
    Object.assign(company, dto);
    return this.companyRepo.save(company);
  }

  async addEmissionPoint(
    companyId: number,
    dto: CreateEmissionPointDto,
  ): Promise<EmissionPoint> {
    await this.findOne(companyId);

    const emissionPoint = this.emissionPointRepo.create({
      ...dto,
      companyId,
    });

    return this.emissionPointRepo.save(emissionPoint);
  }

  async updateEmissionPoint(
    companyId: number,
    empId: number,
    dto: UpdateEmissionPointDto,
  ): Promise<EmissionPoint> {
    await this.findOne(companyId);

    const ep = await this.emissionPointRepo.findOne({
      where: { id: empId, companyId },
    });

    if (!ep) {
      throw new NotFoundException(
        `Punto de emisión ${empId} no encontrado en empresa ${companyId}`,
      );
    }

    Object.assign(ep, dto);
    return this.emissionPointRepo.save(ep);
  }

  async removeEmissionPoint(
    companyId: number,
    empId: number,
  ): Promise<void> {
    await this.findOne(companyId);

    const result = await this.emissionPointRepo.delete({
      id: empId,
      companyId,
    });

    if (result.affected === 0) {
      throw new NotFoundException(
        `Punto de emisión ${empId} no encontrado en empresa ${companyId}`,
      );
    }
  }

  async getSequentials(companyId: number): Promise<CompanySeries[]> {
    await this.findOne(companyId);
    return this.companySeriesRepo.find({
      where: { companyId },
      order: { docType: 'ASC', establishment: 'ASC', emissionPoint: 'ASC' },
    });
  }

  async setSequential(companyId: number, dto: SetSequentialDto): Promise<CompanySeries | null> {
    await this.findOne(companyId);

    // Upsert: create or update the series row
    await this.dataSource.query(
      `INSERT INTO app.company_series
         (com_id, cse_doc_type, cse_establishment, cse_emission_point, cse_next_sequential)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (com_id, cse_doc_type, cse_establishment, cse_emission_point)
       DO UPDATE SET cse_next_sequential = $5`,
      [companyId, dto.docType, dto.establishment, dto.emissionPoint, dto.nextSequential],
    );

    return this.companySeriesRepo.findOne({
      where: {
        companyId,
        docType: dto.docType,
        establishment: dto.establishment,
        emissionPoint: dto.emissionPoint,
      },
    });
  }

  async setDocTypes(
    companyId: number,
    codes: SriDocTypeCode[],
  ): Promise<CompanyDocType[]> {
    await this.findOne(companyId);

    return this.dataSource.transaction(async (manager) => {
      await manager.delete(CompanyDocType, { companyId });

      const docTypes = codes.map((code) =>
        manager.create(CompanyDocType, { companyId, code }),
      );

      return manager.save(CompanyDocType, docTypes);
    });
  }

  async uploadLogo(companyId: number, buffer: Buffer, mimeType: string) {
    const company = await this.findOne(companyId);

    // Delete old logo if exists
    if (company.logoS3Key) {
      await this.s3Service.deleteLogo(company.logoS3Key).catch(() => {});
    }

    const result = await this.s3Service.uploadLogo(company.ruc, buffer, mimeType);
    company.logoS3Key = result.s3Key;
    await this.companyRepo.save(company);

    return { logoS3Key: result.s3Key };
  }

  async deleteLogo(companyId: number): Promise<void> {
    const company = await this.findOne(companyId);
    if (company.logoS3Key) {
      await this.s3Service.deleteLogo(company.logoS3Key).catch(() => {});
      company.logoS3Key = null as any;
      await this.companyRepo.save(company);
    }
  }

  async getLogoUrl(companyId: number) {
    const company = await this.findOne(companyId);
    return { logoS3Key: company.logoS3Key || null };
  }

  async downloadLogo(s3Key: string): Promise<Buffer> {
    return this.s3Service.download(s3Key);
  }
}
