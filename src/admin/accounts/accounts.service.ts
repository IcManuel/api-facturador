import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Account } from '../../entities/account.entity';
import { AccountUser } from '../../entities/account-user.entity';
import { AccountUserRole, AccountStatus } from '../../entities/enums';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateAccountUserDto } from './dto/create-account-user.dto';
import { UpdateAccountUserDto } from './dto/update-account-user.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { NotificationService } from '../../notifications/notification.service';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly repo: Repository<Account>,
    @InjectRepository(AccountUser)
    private readonly userRepo: Repository<AccountUser>,
    private readonly notificationService: NotificationService,
  ) {}

  async findAll(
    page: number,
    limit: number,
    search?: string,
  ): Promise<PaginatedResult<Account>> {
    const qb = this.repo
      .createQueryBuilder('account')
      .leftJoinAndSelect('account.companies', 'company')
      .leftJoinAndSelect('company.plan', 'plan');

    if (search) {
      qb.where(
        'account.name ILIKE :search OR account.ruc ILIKE :search',
        { search: `%${search}%` },
      );
    }

    qb.orderBy('account.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: number): Promise<Account> {
    const account = await this.repo.findOne({
      where: { id },
      relations: ['users', 'companies', 'companies.plan', 'billingPeriods'],
    });
    if (!account) throw new NotFoundException('Cuenta no encontrada');
    return account;
  }

  async create(dto: CreateAccountDto): Promise<Account> {
    const { adminName, adminEmail, adminPassword, ...accountData } = dto;
    const account = this.repo.create({
      ...accountData,
      apiKey: 'ak_' + randomBytes(32).toString('hex'),
    });
    const saved = await this.repo.save(account);

    if (adminName && adminEmail && adminPassword) {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      const user = this.userRepo.create({
        accountId: saved.id,
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: AccountUserRole.ADMIN,
      });
      await this.userRepo.save(user);
    }

    return saved;
  }

  async update(id: number, dto: UpdateAccountDto): Promise<Account> {
    const account = await this.findOne(id);
    const previousWarning = account.warningMessage;
    const wasActive = account.isActive;

    Object.assign(account, dto);
    const saved = await this.repo.save(account);

    // Load companies for notification recipients
    const companyEmails = (account.companies ?? [])
      .filter((c) => c.isActive)
      .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));

    // Notification 5: Warning message created
    if (dto.warningMessage && dto.warningMessage !== previousWarning) {
      this.notificationService.sendWarningMessage({
        accountName: account.name,
        accountEmail: account.email,
        companyEmails,
        message: dto.warningMessage,
      }).catch(() => {});
    }

    // Notification 6: Account blocked (isActive changed to false)
    if (dto.isActive === false && wasActive) {
      this.notificationService.sendAccountBlocked({
        accountName: account.name,
        accountEmail: account.email,
        companyEmails,
      }).catch(() => {});
    }

    return saved;
  }

  async findUsers(accountId: number): Promise<AccountUser[]> {
    await this.findOne(accountId);
    return this.userRepo.find({
      where: { accountId },
      order: { id: 'DESC' },
    });
  }

  async createUser(
    accountId: number,
    dto: CreateAccountUserDto,
  ): Promise<AccountUser> {
    await this.findOne(accountId);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      accountId,
      name: dto.name,
      email: dto.email,
      passwordHash,
      role: dto.role,
    });
    return this.userRepo.save(user);
  }

  async updateUser(
    accountId: number,
    userId: number,
    dto: UpdateAccountUserDto,
  ): Promise<AccountUser> {
    const user = await this.userRepo.findOne({
      where: { id: userId, accountId },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    if (dto.name !== undefined) user.name = dto.name;
    if (dto.email !== undefined) user.email = dto.email;
    if (dto.role !== undefined) user.role = dto.role;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    if (dto.password) {
      user.passwordHash = await bcrypt.hash(dto.password, 10);
    }

    return this.userRepo.save(user);
  }

  async removeUser(accountId: number, userId: number): Promise<AccountUser> {
    const user = await this.userRepo.findOne({
      where: { id: userId, accountId },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    user.isActive = false;
    return this.userRepo.save(user);
  }

  async generateApiKey(accountId: number): Promise<{ apiKey: string }> {
    const account = await this.findOne(accountId);
    account.apiKey = 'ak_' + randomBytes(32).toString('hex');
    await this.repo.save(account);
    return { apiKey: account.apiKey };
  }

  async revokeApiKey(accountId: number): Promise<void> {
    const account = await this.findOne(accountId);
    account.apiKey = null;
    await this.repo.save(account);
  }

  async activate(accountId: number): Promise<Account> {
    const account = await this.repo.findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Cuenta no encontrada');
    account.status = AccountStatus.ACTIVE;
    account.trialEndsAt = null;
    // Anchor the anniversary billing cycle at today's day of month, so the
    // next payment lands exactly one month from the activation date.
    // Cap to 28 to avoid gaps in short months (Feb).
    account.billingCycleDay = Math.min(new Date().getDate(), 28);
    return this.repo.save(account);
  }

  /**
   * Activity report: every tenant with its last usage and document totals.
   * Ordered by lastActivityAt desc (NULLs at the bottom).
   */
  async getActivityReport(): Promise<Array<{
    accountId: number;
    name: string;
    ruc: string;
    email: string;
    type: string;
    status: string;
    isActive: boolean;
    trialEndsAt: Date | null;
    createdAt: Date;
    companiesCount: number;
    documentsTotal: number;
    documentsAuthorized: number;
    documentsRejected: number;
    documentsFailed: number;
    lastDocumentAt: Date | null;
    lastActivityAt: Date | null;
    billingCycleDay: number;
    nextBillingDate: string | null;
    lastPeriodYear: number | null;
    lastPeriodMonth: number | null;
    lastPeriodTotal: number | null;
    lastPeriodStatus: string | null;
    lastPeriodPaidAt: Date | null;
  }>> {
    const rows = await this.repo.manager.query<Array<{
      acc_id: number;
      acc_name: string;
      acc_ruc: string;
      acc_email: string;
      acc_type: string;
      acc_status: string;
      acc_is_active: boolean;
      acc_trial_ends_at: Date | null;
      acc_created_at: Date;
      acc_billing_cycle_day: number;
      companies_count: string;
      documents_total: string;
      documents_authorized: string;
      documents_rejected: string;
      documents_failed: string;
      last_document_at: Date | null;
      last_activity_at: Date | null;
      last_period_year: number | null;
      last_period_month: number | null;
      last_period_total: string | null;
      last_period_status: string | null;
      last_period_paid_at: Date | null;
    }>>(
      `
      WITH per_account AS (
        SELECT
          a.acc_id,
          a.acc_name,
          a.acc_ruc,
          a.acc_email,
          a.acc_type,
          a.acc_status,
          a.acc_is_active,
          a.acc_trial_ends_at,
          a.acc_created_at,
          a.acc_billing_cycle_day,
          COUNT(DISTINCT c.com_id) AS companies_count,
          COUNT(d.doc_id)                                    AS documents_total,
          COUNT(d.doc_id) FILTER (WHERE d.doc_status='AUTHORIZED') AS documents_authorized,
          COUNT(d.doc_id) FILTER (WHERE d.doc_status='REJECTED')   AS documents_rejected,
          COUNT(d.doc_id) FILTER (WHERE d.doc_status='FAILED')     AS documents_failed,
          MAX(d.doc_created_at) AS last_document_at
        FROM app.account a
        LEFT JOIN app.company c   ON c.acc_id = a.acc_id
        LEFT JOIN app.document d  ON d.com_id = c.com_id
        GROUP BY a.acc_id
      ),
      last_period AS (
        SELECT DISTINCT ON (bp.acc_id)
          bp.acc_id,
          bp.bpe_year          AS last_period_year,
          bp.bpe_month         AS last_period_month,
          bp.bpe_total         AS last_period_total,
          bp.bpe_status::text  AS last_period_status,
          bp.bpe_paid_at       AS last_period_paid_at
        FROM app.billing_period bp
        ORDER BY bp.acc_id, bp.bpe_year DESC, bp.bpe_month DESC, bp.bpe_id DESC
      )
      SELECT
        p.*,
        GREATEST(p.last_document_at, p.acc_created_at) AS last_activity_at,
        lp.last_period_year, lp.last_period_month, lp.last_period_total,
        lp.last_period_status, lp.last_period_paid_at
      FROM per_account p
      LEFT JOIN last_period lp ON lp.acc_id = p.acc_id
      ORDER BY GREATEST(p.last_document_at, p.acc_created_at) DESC NULLS LAST;
      `,
    );

    return rows.map((r) => {
      const cycleDay = Number(r.acc_billing_cycle_day) || 1;
      const isActive = r.acc_status === 'active';
      const nextBillingDate = isActive
        ? (require('../billing/billing.service').BillingService.nextBillingDate as (d: Date, cd: number) => Date)(new Date(), cycleDay).toISOString().slice(0, 10)
        : null;
      return {
        accountId: Number(r.acc_id),
        name: r.acc_name,
        ruc: r.acc_ruc,
        email: r.acc_email,
        type: r.acc_type,
        status: r.acc_status,
        isActive: r.acc_is_active,
        trialEndsAt: r.acc_trial_ends_at,
        createdAt: r.acc_created_at,
        companiesCount: Number(r.companies_count),
        documentsTotal: Number(r.documents_total),
        documentsAuthorized: Number(r.documents_authorized),
        documentsRejected: Number(r.documents_rejected),
        documentsFailed: Number(r.documents_failed),
        lastDocumentAt: r.last_document_at,
        lastActivityAt: r.last_activity_at,
        billingCycleDay: cycleDay,
        nextBillingDate,
        lastPeriodYear: r.last_period_year ? Number(r.last_period_year) : null,
        lastPeriodMonth: r.last_period_month ? Number(r.last_period_month) : null,
        lastPeriodTotal: r.last_period_total ? Number(r.last_period_total) : null,
        lastPeriodStatus: r.last_period_status ?? null,
        lastPeriodPaidAt: r.last_period_paid_at,
      };
    });
  }

  /**
   * Extend (or start) the trial period by N days. If the current trial is still
   * in the future, the days are added on top of it; otherwise they count from now.
   */
  async extendTrial(accountId: number, days: number): Promise<Account> {
    const account = await this.repo.findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Cuenta no encontrada');
    const now = new Date();
    const base =
      account.trialEndsAt && account.trialEndsAt.getTime() > now.getTime()
        ? account.trialEndsAt
        : now;
    account.trialEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    account.status = AccountStatus.TRIAL;
    return this.repo.save(account);
  }
}
