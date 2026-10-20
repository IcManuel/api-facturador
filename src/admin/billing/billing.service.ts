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
import { CobroUsoService } from '../../cobro/cobro-uso.service';
import { recalcularBloqueo } from '../../cobro/cobro-bloqueo';
import { Cobro } from '../../cobro/cobro.calculator';
import { addDays, DIAS_VENCIMIENTO, fromYmd, previousCycleStart, ymd } from '../../cobro/cobro.calendar';
import { PaymentMethod } from '../../entities/enums';

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
    private readonly cobroUso: CobroUsoService,
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

    // Mismo motor que cobró el período: rango del ciclo (o el mes calendario en los antiguos)
    const desde = bp.periodStartDate ?? ymd(new Date(bp.year, bp.month - 1, 1));
    const hasta = bp.periodEndDate ? ymd(addDays(fromYmd(bp.periodEndDate), 1)) : ymd(new Date(bp.year, bp.month, 1));
    const cobro = await this.cobroUso.cobro(bp.account, desde, hasta);
    const usage = new Map((await this.cobroUso.usage(bp.accountId, desde, hasta)).map((u) => [u.companyId, u]));
    const companies = cobro.lineas.map((l) => {
      const u = usage.get(l.companyId);
      return {
        companyId: l.companyId,
        companyName: l.name,
        companyRuc: l.ruc,
        planTier: u?.planTier,
        planName: l.planName,
        planPrice: l.base,
        planDocLimit: l.docLimit,
        overageEnabled: u?.overageEnabled ?? false,
        overageUnitPrice: l.overageUnitPrice,
        docsTotal: l.docsTotal,
        docsAuthorized: l.docsAuthorized,
        overageDocs: l.overageDocs,
        overageTotal: l.overageTotal,
        total: l.total,
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
    // Generación manual por mes calendario (botón del administrador). Usa el mismo motor.
    const targetEnd = new Date(year, month, 0);
    const desde = ymd(new Date(year, month - 1, 1));
    const hasta = ymd(new Date(year, month, 1));

    const accounts: { accId: number }[] = await this.dataSource.query(
      `SELECT DISTINCT c.acc_id AS "accId"
       FROM app.company c
       JOIN app.account  a ON a.acc_id = c.acc_id
       WHERE c.com_is_active = true
         AND c.com_billing_start_date IS NOT NULL
         AND c.com_billing_start_date <= $1
         AND a.acc_is_internal = false`,
      [ymd(targetEnd)],
    );

    let created = 0;
    let skipped = 0;
    for (const { accId } of accounts) {
      const existing = await this.repo.findOne({ where: { accountId: accId, year, month } });
      if (existing) { skipped++; continue; }
      const account = await this.accountRepo.findOne({ where: { id: accId } });
      if (!account) { skipped++; continue; }
      const cobro = await this.cobroUso.cobro(account, desde, hasta);
      if (!cobro.lineas.length) { skipped++; continue; }
      await this.guardarPeriodo(account, cobro, { year, month, start: null, end: null, closing: new Date() });
      created++;
    }

    this.logger.log(`Billing periods generated for ${year}-${String(month).padStart(2, '0')}: ${created} created, ${skipped} skipped`);
    return { created, skipped };
  }

  /**
   * Guarda un período cerrado con el cobro del motor único: totales con IVA incluido y su
   * desglose, vencimiento (cierre + 5), detalle por empresa y correo con «Pagar ahora».
   * Si ya existía el primer mes prepagado (activación de la cuenta), lo completa.
   */
  private async guardarPeriodo(
    account: Account,
    cobro: Cobro,
    p: { year: number; month: number; start: string | null; end: string | null; closing: Date },
    prepaid?: BillingPeriod,
  ): Promise<BillingPeriod> {
    const dueDate = ymd(addDays(p.closing, DIAS_VENCIMIENTO));
    const total = cobro.total;
    const representative = cobro.lineas[cobro.lineas.length - 1];
    const representativeLimit = [...cobro.lineas].reverse().find((l) => l.docLimit !== null)?.docLimit ?? null;

    const saved = await this.dataSource.transaction(async (manager) => {
      const bp = prepaid ?? manager.create(BillingPeriod, { accountId: account.id, paidAmount: 0 });
      Object.assign(bp, {
        planId: representative?.planId ?? bp.planId,
        year: p.year,
        month: p.month,
        periodStartDate: p.start,
        periodEndDate: p.end,
        docsTotal: cobro.docsTotal,
        docsAuthorized: cobro.docsAuthorized,
        docLimit: representativeLimit,
        basePrice: cobro.baseTotal,
        overageDocs: cobro.overageDocs,
        overagePrice: representative?.overageUnitPrice ?? 0,
        overageTotal: cobro.overageTotal,
        total,
        subtotal: cobro.subtotal,
        iva: cobro.iva,
        ivaRate: cobro.ivaRate,
        dueDate: prepaid ? prepaid.dueDate ?? dueDate : dueDate,
        closedAt: new Date(),
      });
      bp.status = this.computeStatus(total, Number(bp.paidAmount));
      if (bp.status === BillingStatus.PAID && !bp.paidAt) bp.paidAt = new Date();
      if (bp.status !== BillingStatus.PAID) bp.paidAt = null;
      const row = await manager.save(BillingPeriod, bp);

      for (const l of cobro.lineas) {
        await manager.query(
          `INSERT INTO app.billing_company_detail
             (bpe_id, com_id, bcd_docs_total, bcd_docs_authorized, bcd_base_price, bcd_overage_docs, bcd_overage_total, bcd_subtotal)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (bpe_id, com_id) DO UPDATE SET
             bcd_docs_total = $3, bcd_docs_authorized = $4, bcd_base_price = $5, bcd_overage_docs = $6,
             bcd_overage_total = $7, bcd_subtotal = $8, bcd_updated_at = NOW()`,
          [row.id, l.companyId, l.docsTotal, l.docsAuthorized, l.base, l.overageDocs, l.overageTotal, l.total],
        );
      }
      return row;
    });

    const balance = Math.round((total - Number(saved.paidAmount)) * 100) / 100;
    // Con el panel bloqueado por mora no se envían más correos de cobro
    if (balance > 0 && !account.paymentLock && account.status === AccountStatus.ACTIVE) {
      this.sendBillingNotification(account.id, saved, cobro, balance).catch(() => {});
    }
    return saved;
  }

  // --- Payment management ---

  async addPayment(
    billingPeriodId: number,
    dto: CreatePaymentDto,
    recordedBy: string,
  ): Promise<Payment> {
    return this.dataSource.transaction(async (manager) => {
      const payment = await BillingService.registrarPago(manager, billingPeriodId, {
        amount: dto.amount, method: dto.method, reference: dto.reference ?? null,
        notes: dto.notes ?? null, date: dto.date, recordedBy,
      });
      // Igual que un pago con PagoPlux: si ya no debe lo vencido, se levanta el bloqueo por mora
      await recalcularBloqueo(manager, payment.accountId);
      return payment;
    });
  }

  /**
   * Registra un pago en un período dentro de una transacción (lo usan el administrador y el
   * cobro con PagoPlux). Bloquea la fila del período para que dos pagos simultáneos no se pisen.
   */
  static async registrarPago(
    manager: import('typeorm').EntityManager,
    billingPeriodId: number,
    pago: { amount: number; method: PaymentMethod; reference: string | null; notes: string | null; date: string; recordedBy: string; intentId?: number | null },
  ): Promise<Payment> {
    const bp = await manager.getRepository(BillingPeriod).createQueryBuilder('bp')
      .setLock('pessimistic_write')
      .where('bp.id = :id', { id: billingPeriodId })
      .getOne();
    if (!bp) throw new NotFoundException('Periodo de facturación no encontrado');

    const total = Number(bp.total);
    const currentPaid = Number(bp.paidAmount);
    const newPaid = Math.round((currentPaid + pago.amount) * 100) / 100;
    if (newPaid > total * 1.001) {
      throw new BadRequestException(
        `El pago excede el saldo. Total: $${total.toFixed(2)}, Pagado: $${currentPaid.toFixed(2)}, Saldo: $${(total - currentPaid).toFixed(2)}`,
      );
    }

    const saved = await manager.save(Payment, manager.create(Payment, {
      billingPeriodId,
      accountId: bp.accountId,
      amount: pago.amount,
      method: pago.method,
      reference: pago.reference,
      notes: pago.notes,
      date: pago.date,
      recordedBy: pago.recordedBy,
      intentId: pago.intentId ?? null,
    }));

    bp.paidAmount = newPaid;
    bp.status = BillingService.statusFor(total, newPaid);
    bp.paidAt = bp.status === BillingStatus.PAID ? new Date() : null;
    await manager.save(BillingPeriod, bp);
    return saved;
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
    return BillingService.statusFor(total, paidAmount);
  }

  static statusFor(total: number, paidAmount: number): BillingStatus {
    if (total <= 0) return BillingStatus.PAID;
    if (paidAmount >= total * 0.999) return BillingStatus.PAID;
    if (paidAmount > 0) return BillingStatus.PARTIAL;
    return BillingStatus.PENDING;
  }

  private async sendBillingNotification(accountId: number, bp: BillingPeriod, cobro: Cobro, balance: number) {
    const account = await this.accountRepo.findOne({ where: { id: accountId }, relations: ['companies'] });
    if (!account) return;
    const companyEmails = (account.companies ?? [])
      .filter((c) => c.isActive)
      .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));

    await this.notificationService.sendBillingInvoice({
      accountName: account.name,
      accountEmail: account.email,
      companyEmails,
      year: bp.year,
      month: bp.month,
      periodStart: bp.periodStartDate,
      periodEnd: bp.periodEndDate,
      docsTotal: cobro.docsTotal,
      docsAuthorized: cobro.docsAuthorized,
      basePrice: cobro.baseTotal,
      overageDocs: cobro.overageDocs,
      overageTotal: cobro.overageTotal,
      total: cobro.total,
      subtotal: cobro.subtotal,
      iva: cobro.iva,
      ivaRate: cobro.ivaRate,
      balance,
      dueDate: bp.dueDate,
      lineas: cobro.lineas.map((l) => ({ name: l.name, planName: l.planName, docsAuthorized: l.docsAuthorized, base: l.base, overageDocs: l.overageDocs, overageTotal: l.overageTotal, total: l.total })),
    });
  }

  /* ────────── Anniversary billing (per-account cycle_day) ────────── */

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
   * For each account, generates the period `[previousCycleStart, today - 1 day]` with
   * `year+month` set to the closing month. Idempotent: skips if a period with the
   * same accountId+periodStartDate already exists.
   */
  async closeAnniversaryPeriodsForToday(now: Date = new Date()): Promise<{ created: number; skipped: number; matched: number }> {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayDay = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

    // Cuentas cuyo ciclo cierra hoy (el último día del mes también cierra las de corte 29-31)
    const cycleDayCandidates: number[] = [todayDay];
    if (todayDay === daysInMonth) {
      for (let d = todayDay + 1; d <= 31; d++) cycleDayCandidates.push(d);
    }

    const accounts = await this.accountRepo
      .createQueryBuilder('a')
      .where('a.status = :status', { status: AccountStatus.ACTIVE })
      .andWhere('a.isActive = true')
      .andWhere('a.isInternal = false')
      .andWhere('a.billingCycleDay IN (:...days)', { days: cycleDayCandidates })
      .getMany();

    const hasta = ymd(today);
    const periodEnd = ymd(addDays(today, -1));
    let created = 0;
    let skipped = 0;

    for (const account of accounts) {
      const desde = ymd(previousCycleStart(today, account.billingCycleDay));
      const existing = await this.repo.findOne({ where: { accountId: account.id, periodStartDate: desde } });
      // Ya cerrado: idempotente. El primer mes prepagado (closedAt NULL) se completa con lo usado.
      if (existing && existing.closedAt) { skipped++; continue; }

      const cobro = await this.cobroUso.cobro(account, desde, hasta);
      if (!cobro.lineas.length) { skipped++; continue; }

      await this.guardarPeriodo(account, cobro, {
        year: today.getFullYear(), month: today.getMonth() + 1, start: desde, end: periodEnd, closing: today,
      }, existing ?? undefined);
      created++;
    }

    this.logger.log(`Anniversary billing for ${hasta}: matched=${accounts.length}, created=${created}, skipped=${skipped}`);
    return { created, skipped, matched: accounts.length };
  }

  /* ────────── Reporte diario de cobros ────────── */

  /**
   * Quién debe pagar hoy: cuentas activas cuyo día de corte (día de activación)
   * cae hoy, con el monto que les corresponde en el ciclo que acaba de cerrar.
   *
   * - Planes con cuota fija: se cobra la cuota, más el excedente si está habilitado.
   * - Planes por uso (payperuse): se cobra por comprobante AUTORIZADO en producción,
   *   por lo que solo aparecen si efectivamente emitieron.
   * - Planes ilimitados, cuentas internas y cuentas que no están activas quedan fuera.
   *
   * Solo se listan las cuentas con monto mayor a cero.
   */
  async getCollectionsDueToday(now: Date = new Date()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayDay = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const cycleDays: number[] = [todayDay];
    if (todayDay === daysInMonth) {
      for (let d = todayDay + 1; d <= 31; d++) cycleDays.push(d);
    }
    const todayStr = ymd(today);
    const periodEndStr = ymd(addDays(today, -1));
    const periodStartStr = ymd(previousCycleStart(today, todayDay));

    const dueAccounts = await this.accountRepo
      .createQueryBuilder('a')
      .where('a.status = :status', { status: AccountStatus.ACTIVE })
      .andWhere('a.isActive = true')
      .andWhere('a.isInternal = false')
      .andWhere('a.billingCycleDay IN (:...days)', { days: cycleDays })
      .getMany();

    const byAccount = new Map<number, any>();
    for (const account of dueAccounts) {
      const desde = ymd(previousCycleStart(today, account.billingCycleDay));
      const cobro = await this.cobroUso.cobro(account, desde, todayStr);
      // Primer mes ya pagado al activar: solo se debe lo que no estaba pagado
      const prepaid = await this.repo.findOne({ where: { accountId: account.id, periodStartDate: desde } });
      const yaPagado = prepaid && !prepaid.closedAt ? Number(prepaid.paidAmount) : 0;
      byAccount.set(account.id, {
        accountId: account.id,
        accountName: account.name,
        accountEmail: account.email,
        accountPhone: account.phone,
        cycleDay: account.billingCycleDay,
        tarifa: cobro.tarifa,
        companies: cobro.lineas.map((l) => ({
          companyId: l.companyId,
          companyName: l.name,
          companyRuc: l.ruc,
          planName: l.planName,
          base: l.base,
          docsTotal: l.docsTotal,
          docsAuthorized: l.docsAuthorized,
          docLimit: l.docLimit,
          overageDocs: l.overageDocs,
          overageAmount: l.overageTotal,
          subtotal: l.total,
        })),
        total: Math.max(0, Math.round((cobro.total - yaPagado) * 100) / 100),
        subtotal: cobro.subtotal,
        iva: cobro.iva,
      });
    }

    const accounts = [...byAccount.values()]
      .filter((a) => a.total > 0)
      .sort((a, b) => b.total - a.total);

    // Saldos de períodos anteriores que siguen sin pagarse
    const overdue: any[] = await this.dataSource.query(
      `SELECT
         a.acc_id    AS "accountId",
         a.acc_name  AS "accountName",
         a.acc_email AS "accountEmail",
         bp.bpe_id   AS "periodId",
         bp.bpe_year AS "year",
         bp.bpe_month AS "month",
         bp.bpe_status AS "status",
         bp.bpe_total AS "total",
         COALESCE(bp.bpe_paid_amount, 0) AS "paid",
         bp.bpe_period_end_date AS "periodEnd"
       FROM app.billing_period bp
       JOIN app.account a ON a.acc_id = bp.acc_id
       WHERE bp.bpe_status IN ('pending', 'partial', 'overdue')
         AND bp.bpe_total > COALESCE(bp.bpe_paid_amount, 0)
         AND a.acc_is_internal = false
         AND bp.bpe_closed_at IS NOT NULL
         AND COALESCE(bp.bpe_period_end_date, make_date(bp.bpe_year, bp.bpe_month, 1)) < $1::date
       ORDER BY bp.bpe_year, bp.bpe_month, a.acc_name`,
      [todayStr],
    );

    const overdueRows = overdue.map((o) => ({
      ...o,
      total: Number(o.total),
      paid: Number(o.paid),
      balance: Math.round((Number(o.total) - Number(o.paid)) * 100) / 100,
    }));

    return {
      date: todayStr,
      periodStart: periodStartStr,
      periodEnd: periodEndStr,
      accounts,
      totalDueToday: Math.round(accounts.reduce((s, a) => s + a.total, 0) * 100) / 100,
      overdue: overdueRows,
      totalOverdue: Math.round(overdueRows.reduce((s, o) => s + o.balance, 0) * 100) / 100,
    };
  }

  /**
   * Envía un recordatorio de pago consolidado (un correo por cuenta, con todos
   * sus períodos pendientes). Si no se indican cuentas, toma todas las que
   * tengan saldo, excluyendo las internas.
   */
  async sendPaymentReminders(accountIds?: number[]) {
    const rows: any[] = await this.dataSource.query(
      `SELECT bp.acc_id AS "accountId", bp.bpe_year AS "year", bp.bpe_month AS "month",
              (bp.bpe_total - COALESCE(bp.bpe_paid_amount, 0)) AS "balance"
       FROM app.billing_period bp
       JOIN app.account a ON a.acc_id = bp.acc_id
       WHERE bp.bpe_status IN ('pending', 'partial', 'overdue')
         AND bp.bpe_total > COALESCE(bp.bpe_paid_amount, 0)
         AND a.acc_is_internal = false
         ${accountIds?.length ? 'AND bp.acc_id = ANY($1)' : ''}
       ORDER BY bp.acc_id, bp.bpe_year, bp.bpe_month`,
      accountIds?.length ? [accountIds] : [],
    );

    const byAccount = new Map<number, Array<{ year: number; month: number; balance: number }>>();
    for (const r of rows) {
      const list = byAccount.get(r.accountId) ?? [];
      list.push({ year: r.year, month: r.month, balance: Number(r.balance) });
      byAccount.set(r.accountId, list);
    }

    const sent: Array<{ accountId: number; accountName: string; total: number; periods: number }> = [];

    for (const [accountId, periods] of byAccount) {
      const account = await this.accountRepo.findOne({
        where: { id: accountId },
        relations: ['companies'],
      });
      if (!account) continue;

      const total = Math.round(periods.reduce((s, p) => s + p.balance, 0) * 100) / 100;
      const companyEmails = (account.companies ?? [])
        .filter((c) => c.isActive)
        .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));

      await this.notificationService.sendPaymentReminder({
        accountName: account.name,
        accountEmail: account.email,
        companyEmails,
        periods,
        total,
      });

      sent.push({ accountId, accountName: account.name, total, periods: periods.length });
      this.logger.log(`Payment reminder sent to account ${accountId} (${account.name}) — $${total.toFixed(2)}`);
    }

    return { sent, count: sent.length };
  }
}
