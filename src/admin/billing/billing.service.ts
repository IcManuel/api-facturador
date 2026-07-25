import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BillingPeriod } from '../../entities/billing-period.entity';
import { Payment } from '../../entities/payment.entity';
import { Account } from '../../entities/account.entity';
import { AccountStatus, BillingStatus, PlanTier } from '../../entities/enums';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { NotificationService } from '../../notifications/notification.service';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(BillingPeriod)
    private readonly repo: Repository<BillingPeriod>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly dataSource: DataSource,
    private readonly notificationService: NotificationService,
  ) {}

  async findAll(
    page = 1,
    limit = 20,
    accountId?: number,
    status?: BillingStatus,
    year?: number,
    month?: number,
  ): Promise<PaginatedResult<BillingPeriod>> {
    const qb = this.repo.createQueryBuilder('bp');
    qb.leftJoinAndSelect('bp.account', 'account')
      .leftJoinAndSelect('account.companies', 'company')
      .leftJoinAndSelect('company.plan', 'companyPlan');

    if (accountId) {
      qb.andWhere('bp.accountId = :accountId', { accountId });
    }
    if (status) {
      qb.andWhere('bp.status = :status', { status });
    }
    if (year) {
      qb.andWhere('bp.year = :year', { year });
    }
    if (month) {
      qb.andWhere('bp.month = :month', { month });
    }

    qb.orderBy('bp.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: number) {
    const bp = await this.repo.findOne({
      where: { id },
      relations: ['account', 'account.companies', 'account.companies.plan', 'payments'],
    });
    if (!bp) throw new NotFoundException('Periodo de facturación no encontrado');

    const startDate = new Date(bp.year, bp.month - 1, 1);
    const endDate = new Date(bp.year, bp.month, 1);

    const companyBreakdown: any[] = await this.dataSource.query(
      `SELECT
        c.com_id AS "companyId",
        c.com_name AS "companyName",
        c.com_ruc AS "companyRuc",
        p.spl_tier AS "planTier",
        p.spl_name AS "planName",
        p.spl_monthly_price AS "planPrice",
        p.spl_doc_limit AS "planDocLimit",
        p.spl_overage_price AS "overageUnitPrice",
        c.com_overage_enabled AS "overageEnabled",
        COUNT(d.doc_id)::int AS "docsTotal",
        COUNT(d.doc_id) FILTER (WHERE d.doc_status = 'AUTHORIZED')::int AS "docsAuthorized",
        GREATEST(0, COUNT(d.doc_id)::int - COALESCE(p.spl_doc_limit, 999999999)) AS "overageDocs"
      FROM app.company c
      JOIN app.subscription_plan p ON p.spl_id = c.spl_id
      LEFT JOIN app.document d ON d.com_id = c.com_id
        AND d.doc_created_at >= $1
        AND d.doc_created_at < $2
      WHERE c.acc_id = $3
      GROUP BY c.com_id, c.com_name, c.com_ruc, p.spl_tier, p.spl_name, p.spl_monthly_price,
               p.spl_doc_limit, p.spl_overage_price, c.com_overage_enabled
      ORDER BY c.com_name`,
      [startDate.toISOString(), endDate.toISOString(), bp.accountId],
    );

    const companies = companyBreakdown.map((row) => {
      const planTier = row.planTier as PlanTier;
      const planPrice = Number(row.planPrice);
      const overageUnitPrice = Number(row.overageUnitPrice ?? 0);
      const docsTotal = Number(row.docsTotal);

      let companyTotal: number;
      let overageDocs: number;
      let overageTotal: number;

      if (planTier === PlanTier.UNLIMITED) {
        // Free/unlimited — no charge
        companyTotal = 0;
        overageDocs = 0;
        overageTotal = 0;
      } else if (planTier === PlanTier.PAYPERUSE) {
        // Pay per doc — no base price, all docs charged at overage rate
        overageDocs = docsTotal;
        overageTotal = docsTotal * overageUnitPrice;
        companyTotal = overageTotal;
      } else {
        // Fixed plans (basic, professional, enterprise, custom)
        overageDocs = row.overageEnabled ? Number(row.overageDocs) : 0;
        overageTotal = overageDocs * overageUnitPrice;
        companyTotal = planPrice + overageTotal;
      }

      return {
        companyId: row.companyId,
        companyName: row.companyName,
        companyRuc: row.companyRuc,
        planTier,
        planName: row.planName,
        planPrice,
        planDocLimit: row.planDocLimit,
        overageEnabled: row.overageEnabled,
        overageUnitPrice,
        docsTotal,
        docsAuthorized: Number(row.docsAuthorized),
        overageDocs,
        overageTotal,
        total: companyTotal,
      };
    });

    const payments = (bp.payments ?? []).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return {
      ...bp,
      payments,
      companies,
    };
  }

  // --- Billing period generation ---

  async generateBillingPeriods(year: number, month: number): Promise<{ created: number; skipped: number }> {
    // Get all distinct accounts that have active companies with a billing_start_date <= end of target month
    const targetEnd = new Date(year, month, 0); // last day of month
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);

    const accounts: { accId: number }[] = await this.dataSource.query(
      `SELECT DISTINCT c.acc_id AS "accId"
       FROM app.company c
       WHERE c.com_is_active = true
         AND c.com_billing_start_date IS NOT NULL
         AND c.com_billing_start_date <= $1`,
      [targetEnd.toISOString().slice(0, 10)],
    );

    let created = 0;
    let skipped = 0;

    for (const { accId } of accounts) {
      // Check if billing period already exists
      const existing = await this.repo.findOne({
        where: { accountId: accId, year, month },
      });

      if (existing) {
        skipped++;
        continue;
      }

      // Get all active companies for this account
      const companies: any[] = await this.dataSource.query(
        `SELECT
          c.com_id,
          p.spl_id,
          p.spl_tier AS "planTier",
          p.spl_monthly_price AS "planPrice",
          p.spl_doc_limit AS "docLimit",
          p.spl_overage_price AS "overagePrice",
          c.com_overage_enabled AS "overageEnabled",
          COUNT(d.doc_id)::int AS "docsTotal",
          COUNT(d.doc_id) FILTER (WHERE d.doc_status = 'AUTHORIZED')::int AS "docsAuthorized"
        FROM app.company c
        JOIN app.subscription_plan p ON p.spl_id = c.spl_id
        LEFT JOIN app.document d ON d.com_id = c.com_id
          AND d.doc_created_at >= $1
          AND d.doc_created_at < $2
        WHERE c.acc_id = $3 AND c.com_is_active = true
          AND c.com_billing_start_date <= $4
        GROUP BY c.com_id, p.spl_id, p.spl_tier, p.spl_monthly_price, p.spl_doc_limit,
                 p.spl_overage_price, c.com_overage_enabled`,
        [startDate.toISOString(), endDate.toISOString(), accId, targetEnd.toISOString().slice(0, 10)],
      );

      if (companies.length === 0) {
        skipped++;
        continue;
      }

      // Calculate totals across all companies for this account
      let totalBase = 0;
      let totalOverageDocs = 0;
      let totalOverageAmount = 0;
      let totalDocs = 0;
      let totalDocsAuthorized = 0;
      let representativePlanId = companies[0].spl_id;
      let representativeDocLimit: number | null = null;
      let representativeOveragePrice = 0;

      for (const c of companies) {
        const tier = c.planTier as PlanTier;
        const planPrice = Number(c.planPrice);
        const overagePrice = Number(c.overagePrice ?? 0);
        const docLimit = c.docLimit ? Number(c.docLimit) : null;
        const docsTotal = Number(c.docsTotal);

        totalDocs += docsTotal;
        totalDocsAuthorized += Number(c.docsAuthorized);

        if (tier === PlanTier.UNLIMITED) {
          // No charge
        } else if (tier === PlanTier.PAYPERUSE) {
          totalOverageDocs += docsTotal;
          totalOverageAmount += docsTotal * overagePrice;
          representativeOveragePrice = overagePrice;
        } else {
          totalBase += planPrice;
          if (docLimit !== null) {
            const overage = c.overageEnabled ? Math.max(0, docsTotal - docLimit) : 0;
            totalOverageDocs += overage;
            totalOverageAmount += overage * overagePrice;
          }
          representativeDocLimit = docLimit;
          representativeOveragePrice = overagePrice;
        }

        representativePlanId = c.spl_id;
      }

      const total = totalBase + totalOverageAmount;

      // For unlimited plans with $0 total, mark as paid immediately
      const status = total <= 0 ? BillingStatus.PAID : BillingStatus.PENDING;

      const bp = this.repo.create({
        accountId: accId,
        planId: representativePlanId,
        year,
        month,
        docsTotal: totalDocs,
        docsAuthorized: totalDocsAuthorized,
        docLimit: representativeDocLimit,
        basePrice: totalBase,
        overageDocs: totalOverageDocs,
        overagePrice: representativeOveragePrice,
        overageTotal: totalOverageAmount,
        total,
        paidAmount: total <= 0 ? total : 0,
        status,
        paidAt: total <= 0 ? new Date() : null,
      });

      await this.repo.save(bp);
      created++;

      // Notification 7: billing invoice generated (only for non-zero totals)
      if (total > 0) {
        this.sendBillingNotification(accId, year, month, totalDocs, totalBase, totalOverageDocs, totalOverageAmount, total)
          .catch(() => {});
      }
    }

    this.logger.log(`Billing periods generated for ${year}-${String(month).padStart(2, '0')}: ${created} created, ${skipped} skipped`);
    return { created, skipped };
  }

  // --- Payment management ---

  async addPayment(
    billingPeriodId: number,
    dto: CreatePaymentDto,
    recordedBy: string,
  ): Promise<Payment> {
    const bp = await this.repo.findOne({ where: { id: billingPeriodId } });
    if (!bp) throw new NotFoundException('Periodo de facturación no encontrado');

    const total = Number(bp.total);
    const currentPaid = Number(bp.paidAmount);
    const newPaid = currentPaid + dto.amount;

    if (newPaid > total * 1.001) {
      throw new BadRequestException(
        `El pago excede el saldo. Total: $${total.toFixed(2)}, Pagado: $${currentPaid.toFixed(2)}, Saldo: $${(total - currentPaid).toFixed(2)}`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const payment = manager.create(Payment, {
        billingPeriodId,
        accountId: bp.accountId,
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference ?? null,
        notes: dto.notes ?? null,
        date: dto.date,
        recordedBy,
      });

      const saved = await manager.save(Payment, payment);

      bp.paidAmount = newPaid;
      bp.status = this.computeStatus(total, newPaid);
      if (bp.status === BillingStatus.PAID) {
        bp.paidAt = new Date();
      }
      await manager.save(BillingPeriod, bp);

      return saved;
    });
  }

  async removePayment(billingPeriodId: number, paymentId: number): Promise<void> {
    const payment = await this.paymentRepo.findOne({
      where: { id: paymentId, billingPeriodId },
    });
    if (!payment) throw new NotFoundException('Pago no encontrado');

    return this.dataSource.transaction(async (manager) => {
      await manager.remove(Payment, payment);

      const { sum } = await manager
        .createQueryBuilder(Payment, 'p')
        .select('COALESCE(SUM(p.amount), 0)', 'sum')
        .where('p.billingPeriodId = :bpId AND p.id != :payId', {
          bpId: billingPeriodId,
          payId: paymentId,
        })
        .getRawOne();

      const bp = await manager.findOne(BillingPeriod, { where: { id: billingPeriodId } });
      if (bp) {
        bp.paidAmount = Number(sum);
        bp.status = this.computeStatus(Number(bp.total), Number(sum));
        if (bp.status !== BillingStatus.PAID) {
          bp.paidAt = null;
        }
        await manager.save(BillingPeriod, bp);
      }
    });
  }

  async getDebtSummary(): Promise<any[]> {
    const rows = await this.dataSource.query(`
      SELECT
        a.acc_id AS "accountId",
        a.acc_name AS "accountName",
        a.acc_ruc AS "accountRuc",
        COUNT(bp.bpe_id)::int AS "pendingPeriods",
        SUM(bp.bpe_total - bp.bpe_paid_amount)::numeric(10,2) AS "totalDebt",
        MIN(CONCAT(bp.bpe_year, '-', LPAD(bp.bpe_month::text, 2, '0'))) AS "oldestPeriod"
      FROM app.billing_period bp
      JOIN app.account a ON a.acc_id = bp.acc_id
      WHERE bp.bpe_status IN ('pending', 'partial', 'overdue')
      GROUP BY a.acc_id, a.acc_name, a.acc_ruc
      HAVING SUM(bp.bpe_total - bp.bpe_paid_amount) > 0
      ORDER BY SUM(bp.bpe_total - bp.bpe_paid_amount) DESC
    `);
    return rows;
  }

  private computeStatus(total: number, paidAmount: number): BillingStatus {
    if (total <= 0) return BillingStatus.PAID;
    if (paidAmount >= total * 0.999) return BillingStatus.PAID;
    if (paidAmount > 0) return BillingStatus.PARTIAL;
    return BillingStatus.PENDING;
  }

  private async sendBillingNotification(
    accountId: number, year: number, month: number,
    docsTotal: number, basePrice: number,
    overageDocs: number, overageTotal: number, total: number,
  ) {
    const account = await this.accountRepo.findOne({
      where: { id: accountId },
      relations: ['companies'],
    });
    if (!account) return;

    const companyEmails = (account.companies ?? [])
      .filter((c) => c.isActive)
      .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));

    await this.notificationService.sendBillingInvoice({
      accountName: account.name,
      accountEmail: account.email,
      companyEmails,
      year, month, docsTotal, basePrice, overageDocs, overageTotal, total,
    });
  }

  /* ────────── Anniversary billing (per-account cycle_day) ────────── */

  /**
   * Compute the previous cycle date (activation-day of previous month) given a
   * closing date (today for the cron). Handles months with fewer days.
   */
  private prevCycleDate(closing: Date): Date {
    const prev = new Date(closing);
    prev.setMonth(prev.getMonth() - 1);
    // If overflowed into an earlier month (e.g. Mar 31 → Mar 3 because Feb has 28),
    // clip to the last day of the intended previous month.
    if (prev.getMonth() !== (closing.getMonth() - 1 + 12) % 12) {
      prev.setDate(0);
    }
    return prev;
  }

  /** Next occurrence of `cycleDay` from `from`, adjusted to month length. */
  static nextBillingDate(from: Date, cycleDay: number): Date {
    const y = from.getFullYear();
    const m = from.getMonth();
    const daysThisMonth = new Date(y, m + 1, 0).getDate();
    const effectiveThisMonth = Math.min(cycleDay, daysThisMonth);
    const thisMonthDate = new Date(y, m, effectiveThisMonth);
    if (thisMonthDate > from) return thisMonthDate;
    const daysNextMonth = new Date(y, m + 2, 0).getDate();
    return new Date(y, m + 1, Math.min(cycleDay, daysNextMonth));
  }

  /**
   * Cron-friendly: close all billing periods that end today.
   *
   * Selects active accounts whose `billingCycleDay` matches today (or, if today
   * is the last day of the month and the month is shorter than some cycle days,
   * also matches accounts with cycle_day beyond the month length).
   *
   * For each account, generates the period `[prevCycleDate, today - 1 day]` with
   * `year+month` set to the closing month. Idempotent: skips if a period with the
   * same accountId+periodStartDate already exists.
   */
  async closeAnniversaryPeriodsForToday(now: Date = new Date()): Promise<{ created: number; skipped: number; matched: number }> {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const y = today.getFullYear();
    const m = today.getMonth();
    const todayDay = today.getDate();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const isLastDay = todayDay === daysInMonth;

    // Which cycle_day values are considered "ending today"?
    const cycleDayCandidates: number[] = [todayDay];
    if (isLastDay) {
      for (let d = todayDay + 1; d <= 31; d++) cycleDayCandidates.push(d);
    }

    const accounts = await this.accountRepo
      .createQueryBuilder('a')
      .where('a.status = :status', { status: AccountStatus.ACTIVE })
      .andWhere('a.isActive = true')
      .andWhere('a.billingCycleDay IN (:...days)', { days: cycleDayCandidates })
      .getMany();

    const prev = this.prevCycleDate(today);
    const periodStartStr = prev.toISOString().slice(0, 10);
    const periodEnd = new Date(today);
    periodEnd.setDate(periodEnd.getDate() - 1);
    const periodEndStr = periodEnd.toISOString().slice(0, 10);
    const closingYear = today.getFullYear();
    const closingMonth = today.getMonth() + 1;

    let created = 0;
    let skipped = 0;

    for (const account of accounts) {
      const existing = await this.repo.findOne({
        where: { accountId: account.id, periodStartDate: periodStartStr },
      });
      if (existing) { skipped++; continue; }

      const companies: any[] = await this.dataSource.query(
        `SELECT
          c.com_id,
          p.spl_id,
          p.spl_tier AS "planTier",
          p.spl_monthly_price AS "planPrice",
          p.spl_doc_limit AS "docLimit",
          p.spl_overage_price AS "overagePrice",
          c.com_overage_enabled AS "overageEnabled",
          COUNT(d.doc_id)::int AS "docsTotal",
          COUNT(d.doc_id) FILTER (WHERE d.doc_status = 'AUTHORIZED')::int AS "docsAuthorized"
        FROM app.company c
        JOIN app.subscription_plan p ON p.spl_id = c.spl_id
        LEFT JOIN app.document d ON d.com_id = c.com_id
          AND d.doc_created_at >= $1
          AND d.doc_created_at < $2
        WHERE c.acc_id = $3 AND c.com_is_active = true
        GROUP BY c.com_id, p.spl_id, p.spl_tier, p.spl_monthly_price, p.spl_doc_limit,
                 p.spl_overage_price, c.com_overage_enabled`,
        [`${periodStartStr}T00:00:00`, `${today.toISOString().slice(0, 10)}T00:00:00`, account.id],
      );

      if (companies.length === 0) { skipped++; continue; }

      let totalBase = 0;
      let totalOverageDocs = 0;
      let totalOverageAmount = 0;
      let totalDocs = 0;
      let totalDocsAuthorized = 0;
      let representativePlanId = companies[0].spl_id;
      let representativeDocLimit: number | null = null;
      let representativeOveragePrice = 0;

      for (const c of companies) {
        const tier = c.planTier as PlanTier;
        const planPrice = Number(c.planPrice);
        const overagePrice = Number(c.overagePrice ?? 0);
        const docLimit = c.docLimit ? Number(c.docLimit) : null;
        const docsTotal = Number(c.docsTotal);

        totalDocs += docsTotal;
        totalDocsAuthorized += Number(c.docsAuthorized);

        if (tier === PlanTier.UNLIMITED) {
          // no charge
        } else if (tier === PlanTier.PAYPERUSE) {
          const authorized = Number(c.docsAuthorized);
          totalOverageDocs += authorized;
          totalOverageAmount += authorized * overagePrice;
          representativeOveragePrice = overagePrice;
        } else {
          totalBase += planPrice;
          if (docLimit !== null) {
            const overage = c.overageEnabled ? Math.max(0, docsTotal - docLimit) : 0;
            totalOverageDocs += overage;
            totalOverageAmount += overage * overagePrice;
          }
          representativeDocLimit = docLimit;
          representativeOveragePrice = overagePrice;
        }

        representativePlanId = c.spl_id;
      }

      const total = totalBase + totalOverageAmount;
      const status = total <= 0 ? BillingStatus.PAID : BillingStatus.PENDING;

      await this.repo.save(this.repo.create({
        accountId: account.id,
        planId: representativePlanId,
        year: closingYear,
        month: closingMonth,
        periodStartDate: periodStartStr,
        periodEndDate: periodEndStr,
        docsTotal: totalDocs,
        docsAuthorized: totalDocsAuthorized,
        docLimit: representativeDocLimit,
        basePrice: totalBase,
        overageDocs: totalOverageDocs,
        overagePrice: representativeOveragePrice,
        overageTotal: totalOverageAmount,
        total,
        paidAmount: total <= 0 ? total : 0,
        status,
        paidAt: total <= 0 ? new Date() : null,
      }));
      created++;

      if (total > 0) {
        this.sendBillingNotification(account.id, closingYear, closingMonth, totalDocs, totalBase, totalOverageDocs, totalOverageAmount, total)
          .catch(() => {});
      }
    }

    this.logger.log(`Anniversary billing for ${today.toISOString().slice(0, 10)}: matched=${accounts.length}, created=${created}, skipped=${skipped}`);
    return { created, skipped, matched: accounts.length };
  }
}
