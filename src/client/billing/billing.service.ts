import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { BillingPeriod } from '../../entities/billing-period.entity';
import { BillingCompanyDetail } from '../../entities/billing-company-detail.entity';
import { Payment } from '../../entities/payment.entity';
import { Company } from '../../entities/company.entity';
import { Document } from '../../entities/document.entity';
import { Account } from '../../entities/account.entity';
import { DocStatus, AccountType, CompanyEnv } from '../../entities/enums';
import { CobroUsoService } from '../../cobro/cobro-uso.service';
import { Cobro } from '../../cobro/cobro.calculator';
import { currentCycle, ymd } from '../../cobro/cobro.calendar';

@Injectable()
export class ClientBillingService {
  constructor(
    @InjectRepository(BillingPeriod)
    private readonly billingRepo: Repository<BillingPeriod>,
    @InjectRepository(BillingCompanyDetail)
    private readonly billingDetailRepo: Repository<BillingCompanyDetail>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly cobroUso: CobroUsoService,
  ) {}

  /** Ciclo vigente de la cuenta y lo que se le cobraría si cerrara hoy (mismo motor del cierre). */
  private async estimacion(account: Account) {
    const { start, end } = currentCycle(new Date(), account.billingCycleDay);
    const desde = ymd(start);
    const hasta = ymd(end);
    // Hasta mañana: incluye lo emitido hoy
    const hoy = new Date();
    const manana = ymd(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1));
    const cobro = await this.cobroUso.cobro(account, desde, manana < hasta ? manana : hasta);
    // Primer mes ya pagado al activar la cuenta
    const prepaid = await this.billingRepo.findOne({ where: { accountId: account.id, periodStartDate: desde } });
    const yaPagado = prepaid && !prepaid.closedAt ? Number(prepaid.paidAmount) : 0;
    return { cycle: { start: desde, end: hasta, closesOn: hasta }, cobro, yaPagado };
  }

  private resumenCobro(cobro: Cobro, yaPagado: number) {
    return {
      total: cobro.total,
      subtotal: cobro.subtotal,
      iva: cobro.iva,
      ivaRate: cobro.ivaRate,
      ivaIncluido: true,
      yaPagado,
      aPagarAlCierre: Math.max(0, Math.round((cobro.total - yaPagado) * 100) / 100),
      tarifa: cobro.tarifa,
      precioPorEmpresa: cobro.precioPorEmpresa,
      baseTotal: cobro.baseTotal,
      overageDocs: cobro.overageDocs,
      overageTotal: cobro.overageTotal,
    };
  }

  async getBillingSummary(accountId: number, companyId: number) {
    // Verify company belongs to account
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
      relations: ['plan'],
    });
    if (!company || company.accountId !== accountId) {
      throw new ForbiddenException('No tiene acceso a esta empresa');
    }

    const account = await this.accountRepo.findOne({ where: { id: accountId } });

    // Uso del ciclo vigente (del día de corte al siguiente), solo producción
    const { cycle, cobro, yaPagado } = await this.estimacion(account!);
    const linea = cobro.lineas.find((l) => l.companyId === companyId);
    const docsThisMonth = linea?.docsTotal ?? 0;
    const docsAuthorized = linea?.docsAuthorized ?? 0;
    const docsRejected = await this.documentRepo.createQueryBuilder('d')
      .where('d.companyId = :companyId', { companyId })
      .andWhere('d.env = :env', { env: CompanyEnv.PRODUCTION })
      .andWhere('d.status = :status', { status: DocStatus.REJECTED })
      .andWhere(`d.createdAt >= (:desde::date)::timestamp AT TIME ZONE 'America/Guayaquil'`, { desde: cycle.start })
      .getCount();

    // Último período cerrado
    const currentPeriod = await this.billingRepo.findOne({
      where: { accountId },
      relations: ['plan'],
      order: { id: 'DESC' },
    });

    // All billing periods for history (last 12 months)
    const periods = await this.billingRepo.find({
      where: { accountId },
      relations: ['plan', 'payments'],
      order: { year: 'DESC', month: 'DESC' },
      take: 12,
    });

    // Debt: sum of unpaid periods
    const unpaidPeriods = periods.filter((p) => p.status !== 'paid');
    const totalDebt = unpaidPeriods.reduce((sum, p) => sum + Number(p.total) - Number(p.paidAmount), 0);

    // Plan info
    const plan = company.plan;
    const docLimit = plan?.docLimit ?? null;
    // El límite del plan se mide con documentos AUTORIZADOS (los rechazados no cuentan)
    const usagePercent = docLimit ? Math.min((docsAuthorized / docLimit) * 100, 100) : null;
    const overageDocs = linea?.overageDocs ?? 0;

    return {
      // Plan
      plan: plan ? {
        id: plan.id,
        name: plan.name,
        tier: plan.tier,
        monthlyPrice: plan.monthlyPrice,
        docLimit: plan.docLimit,
        overagePrice: plan.overagePrice,
        features: plan.features,
      } : null,

      // Current month usage
      usage: {
        docsThisMonth,
        docsAuthorized,
        docsRejected,
        docLimit,
        usagePercent,
        overageDocs,
        overageEnabled: company.overageEnabled,
      },

      // Current period billing
      currentPeriod: currentPeriod ? this.formatPeriod(currentPeriod) : null,

      // Billing history
      history: periods.map((p) => this.formatPeriod(p)),

      // Debt summary
      debt: {
        total: totalDebt,
        unpaidPeriods: unpaidPeriods.length,
      },

      // Ciclo vigente y lo que se cobraría al cerrarlo (toda la cuenta, IVA incluido)
      cycle,
      estimate: this.resumenCobro(cobro, yaPagado),
      company: linea ? { base: linea.base, overageTotal: linea.overageTotal, total: linea.total } : null,

      // Account info
      warningMessage: account?.warningMessage || null,
    };
  }

  async getAccountBilling(accountId: number) {
    const account = await this.accountRepo.findOne({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    if (account.type !== AccountType.MULTI) {
      throw new BadRequestException(
        'La facturación consolidada solo está disponible para cuentas multi-empresa',
      );
    }

    const { cycle, cobro, yaPagado } = await this.estimacion(account);

    // Último período cerrado e historial
    const currentPeriod = await this.billingRepo.findOne({
      where: { accountId },
      relations: ['plan', 'payments'],
      order: { id: 'DESC' },
    });
    const periods = await this.billingRepo.find({
      where: { accountId },
      relations: ['plan', 'payments'],
      order: { id: 'DESC' },
      take: 12,
    });
    const unpaidPeriods = periods.filter((p) => p.status !== 'paid');
    const totalDebt = unpaidPeriods.reduce((sum, p) => sum + Number(p.total) - Number(p.paidAmount), 0);

    const companyBreakdown = cobro.lineas.map((l) => ({
      companyId: l.companyId,
      name: l.name,
      ruc: l.ruc,
      planName: l.planName,
      docsThisMonth: l.docsTotal,
      docsAuthorized: l.docsAuthorized,
      docLimit: l.docLimit,
      basePrice: l.base,
      overageDocs: l.overageDocs,
      overageTotal: l.overageTotal,
      subtotal: l.total,
    }));

    return {
      accountBilling: {
        currentPeriod: currentPeriod ? this.formatPeriod(currentPeriod) : null,
        history: periods.map((p) => this.formatPeriod(p)),
        debt: {
          total: totalDebt,
          unpaidPeriods: unpaidPeriods.length,
        },
      },
      companyBreakdown,
      totals: {
        companies: companyBreakdown.length,
        docs: cobro.docsTotal,
        baseTotal: cobro.baseTotal,
        overageTotal: cobro.overageTotal,
        grandTotal: cobro.total,
        subtotal: cobro.subtotal,
        iva: cobro.iva,
      },
      cycle,
      estimate: this.resumenCobro(cobro, yaPagado),
      warningMessage: account.warningMessage || null,
    };
  }

  private formatPeriod(p: BillingPeriod) {
    return {
      id: p.id,
      year: p.year,
      month: p.month,
      label: p.periodStartDate && p.periodEndDate
        ? `${p.periodStartDate.split('-').reverse().join('/')} – ${p.periodEndDate.split('-').reverse().join('/')}`
        : `${String(p.month).padStart(2, '0')}/${p.year}`,
      periodStart: p.periodStartDate,
      periodEnd: p.periodEndDate,
      dueDate: p.dueDate,
      subtotal: Number(p.subtotal),
      iva: Number(p.iva),
      ivaRate: Number(p.ivaRate),
      docsTotal: p.docsTotal,
      docsAuthorized: p.docsAuthorized,
      docLimit: p.docLimit,
      basePrice: Number(p.basePrice),
      overageDocs: p.overageDocs,
      overagePrice: Number(p.overagePrice),
      overageTotal: Number(p.overageTotal),
      total: Number(p.total),
      paidAmount: Number(p.paidAmount),
      balance: Number(p.total) - Number(p.paidAmount),
      status: p.status,
      paidAt: p.paidAt,
      planName: p.plan?.name || null,
      payments: (p.payments || []).map((pay) => ({
        id: pay.id,
        amount: Number(pay.amount),
        method: pay.method,
        reference: pay.reference,
        date: pay.date,
      })),
    };
  }
}

