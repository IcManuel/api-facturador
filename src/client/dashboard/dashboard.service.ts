import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import { Company } from '../../entities/company.entity';
import { Document } from '../../entities/document.entity';
import { BillingPeriod } from '../../entities/billing-period.entity';
import { Certificate } from '../../entities/certificate.entity';
import { Account } from '../../entities/account.entity';
import { DocStatus, AccountType } from '../../entities/enums';

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const DOC_TYPE_LABELS: Record<string, string> = {
  '01': 'Factura',
  '03': 'Liq. Compras',
  '04': 'Nota Crédito',
  '05': 'Nota Débito',
  '06': 'Guía Remisión',
  '07': 'Retención',
};

import { CobroUsoService } from '../../cobro/cobro-uso.service';
import { currentCycle, ymd } from '../../cobro/cobro.calendar';

@Injectable()
export class ClientDashboardService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(BillingPeriod)
    private readonly billingRepo: Repository<BillingPeriod>,
    @InjectRepository(Certificate)
    private readonly certificateRepo: Repository<Certificate>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly cobroUso: CobroUsoService,
  ) {}

  /**
   * Lo que se cobraría al cerrar el ciclo vigente (mismo motor del cierre, IVA incluido),
   * con la forma que ya usa el dashboard.
   */
  private async estimacionCiclo(accountId: number, companyId: number) {
    const account = await this.accountRepo.findOne({ where: { id: accountId } });
    if (!account) return null;
    const { start, end } = currentCycle(new Date(), account.billingCycleDay);
    const hoy = new Date();
    const manana = ymd(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1));
    const hasta = ymd(end);
    const cobro = await this.cobroUso.cobro(account, ymd(start), manana < hasta ? manana : hasta);
    const linea = cobro.lineas.find((l) => l.companyId === companyId);
    return {
      total: cobro.total,
      subtotal: cobro.subtotal,
      iva: cobro.iva,
      ivaIncluido: true,
      basePrice: cobro.baseTotal,
      overageDocs: cobro.overageDocs,
      overageTotal: cobro.overageTotal,
      docLimit: linea?.docLimit ?? null,
      cycleStart: ymd(start),
      cycleEnd: hasta,
    };
  }

  async getDashboard(accountId: number, companyId: number) {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
      relations: ['plan'],
    });

    if (!company) {
      throw new NotFoundException('Empresa no encontrada');
    }
    if (company.accountId !== accountId) {
      throw new ForbiddenException('No tiene acceso a esta empresa');
    }

    const account = await this.accountRepo.findOne({
      where: { id: accountId },
    });

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [
      docsThisMonth,
      docsRejected,
      docsAuthorized,
      billing,
      certificate,
      weeklyChart,
      docTypeDistributionRaw,
      totalAmountThisMonth,
      docsToday,
      avgLatencyResult,
      accountSummary,
    ] = await Promise.all([
      this.documentRepo.count({
        where: { companyId, createdAt: Between(monthStart, monthEnd) },
      }),
      this.documentRepo.count({
        where: {
          companyId,
          status: DocStatus.REJECTED,
          createdAt: Between(monthStart, monthEnd),
        },
      }),
      this.documentRepo.count({
        where: {
          companyId,
          status: DocStatus.AUTHORIZED,
          createdAt: Between(monthStart, monthEnd),
        },
      }),
      this.estimacionCiclo(accountId, companyId),
      this.certificateRepo.findOne({
        where: { companyId, isCurrent: true },
        order: { uploadedAt: 'DESC' },
      }),
      this.getWeeklyChart(companyId),

      // Doc type distribution
      this.documentRepo.query(
        `SELECT doc_type_code as code, COUNT(*) as count,
                COALESCE(SUM(doc_total_amount), 0) as amount
         FROM app.document
         WHERE com_id = $1
           AND doc_created_at >= $2 AND doc_created_at <= $3
         GROUP BY doc_type_code
         ORDER BY count DESC`,
        [companyId, monthStart, monthEnd],
      ),

      // Total amount authorized this month
      this.documentRepo
        .createQueryBuilder('doc')
        .select('COALESCE(SUM(doc.totalAmount), 0)', 'total')
        .where('doc.companyId = :companyId', { companyId })
        .andWhere(
          'doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd',
          { monthStart, monthEnd },
        )
        .andWhere('doc.status = :status', { status: DocStatus.AUTHORIZED })
        .getRawOne()
        .then((r) => Number(r?.total ?? 0)),

      // Docs today
      this.documentRepo.count({
        where: { companyId, createdAt: Between(todayStart, now) },
      }),

      // Avg processing time
      this.documentRepo
        .query(
          `SELECT AVG(sub.doc_processing_time_ms) as avg
           FROM (
             SELECT doc_processing_time_ms FROM app.document
             WHERE com_id = $1 AND doc_processing_time_ms IS NOT NULL
             ORDER BY doc_created_at DESC
             LIMIT 50
           ) sub`,
          [companyId],
        )
        .then((rows) => rows[0] ?? { avg: null }),

      // Account-level summary
      this.getAccountSummary(accountId, monthStart, monthEnd),
    ]);

    const docTypeDistribution = (docTypeDistributionRaw || []).map(
      (row: { code: string; count: string; amount: string }) => ({
        code: row.code,
        label: DOC_TYPE_LABELS[row.code] || row.code,
        count: Number(row.count),
        amount: Number(row.amount),
      }),
    );

    const avgMs = avgLatencyResult?.avg ? Number(avgLatencyResult.avg) : 0;

    return {
      company,
      docsThisMonth,
      docsRejected,
      docsAuthorized,
      docsToday,
      totalAmountThisMonth,
      avgProcessingMs: Math.round(avgMs),
      billing: billing || null,
      certificate: certificate || null,
      weeklyChart,
      docTypeDistribution,
      warningMessage: account?.warningMessage || null,
      accountSummary,
    };
  }

  async getAccountDashboard(accountId: number) {
    const account = await this.accountRepo.findOne({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    if (account.type !== AccountType.MULTI) {
      throw new BadRequestException(
        'El dashboard consolidado solo está disponible para cuentas multi-empresa',
      );
    }

    const companies = await this.companyRepo.find({
      where: { accountId, isActive: true },
      relations: ['plan'],
    });

    if (companies.length === 0) {
      return {
        companies: [],
        totals: { docs: 0, authorized: 0, rejected: 0, amount: 0, companies: 0 },
        weeklyChart: [],
        alerts: [],
        warningMessage: account.warningMessage || null,
      };
    }

    const companyIds = companies.map((c) => c.id);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    // Get per-company stats in parallel
    const companyStats = await Promise.all(
      companies.map(async (company) => {
        const [docsThisMonth, docsAuthorized, docsRejected, totalAmountResult, certificate] =
          await Promise.all([
            this.documentRepo.count({
              where: { companyId: company.id, createdAt: Between(monthStart, monthEnd) },
            }),
            this.documentRepo.count({
              where: {
                companyId: company.id,
                status: DocStatus.AUTHORIZED,
                createdAt: Between(monthStart, monthEnd),
              },
            }),
            this.documentRepo.count({
              where: {
                companyId: company.id,
                status: DocStatus.REJECTED,
                createdAt: Between(monthStart, monthEnd),
              },
            }),
            this.documentRepo
              .createQueryBuilder('doc')
              .select('COALESCE(SUM(doc.totalAmount), 0)', 'total')
              .where('doc.companyId = :companyId', { companyId: company.id })
              .andWhere('doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd', {
                monthStart,
                monthEnd,
              })
              .andWhere('doc.status = :status', { status: DocStatus.AUTHORIZED })
              .getRawOne()
              .then((r) => Number(r?.total ?? 0)),
            this.certificateRepo.findOne({
              where: { companyId: company.id, isCurrent: true },
              order: { uploadedAt: 'DESC' },
            }),
          ]);

        const docLimit = company.plan?.docLimit ?? null;
        const planUsagePercent = docLimit
          ? Math.min(Math.round((docsThisMonth / docLimit) * 100), 100)
          : null;

        let certDaysLeft: number | null = null;
        if (certificate?.expiresAt) {
          certDaysLeft = Math.ceil(
            (new Date(certificate.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
        }

        return {
          id: company.id,
          name: company.name,
          tradeName: company.tradeName,
          ruc: company.ruc,
          env: company.env,
          status: company.status,
          docsThisMonth,
          docsAuthorized,
          docsRejected,
          totalAmount: totalAmountResult,
          certDaysLeft,
          planName: company.plan?.name ?? null,
          planUsagePercent,
        };
      }),
    );

    // Aggregate totals
    const totals = {
      docs: companyStats.reduce((sum, c) => sum + c.docsThisMonth, 0),
      authorized: companyStats.reduce((sum, c) => sum + c.docsAuthorized, 0),
      rejected: companyStats.reduce((sum, c) => sum + c.docsRejected, 0),
      amount: companyStats.reduce((sum, c) => sum + c.totalAmount, 0),
      companies: companyStats.length,
    };

    // Weekly chart aggregated across all companies
    const weeklyChart = await this.getWeeklyChartMulti(companyIds);

    // Generate alerts
    const alerts: { type: string; companyId: number; companyName: string; message: string }[] = [];
    for (const cs of companyStats) {
      if (cs.certDaysLeft !== null && cs.certDaysLeft < 0) {
        alerts.push({
          type: 'cert_expired',
          companyId: cs.id,
          companyName: cs.name,
          message: `Certificado vencido hace ${Math.abs(cs.certDaysLeft)} días`,
        });
      } else if (cs.certDaysLeft !== null && cs.certDaysLeft <= 60) {
        alerts.push({
          type: 'cert_expiring',
          companyId: cs.id,
          companyName: cs.name,
          message: `Certificado vence en ${cs.certDaysLeft} días`,
        });
      }
      if (cs.planUsagePercent !== null && cs.planUsagePercent >= 100) {
        alerts.push({
          type: 'plan_limit',
          companyId: cs.id,
          companyName: cs.name,
          message: 'Límite de documentos alcanzado',
        });
      } else if (cs.planUsagePercent !== null && cs.planUsagePercent >= 80) {
        alerts.push({
          type: 'plan_warning',
          companyId: cs.id,
          companyName: cs.name,
          message: `${cs.planUsagePercent}% del plan utilizado`,
        });
      }
      if (cs.status === 'suspended') {
        alerts.push({
          type: 'suspended',
          companyId: cs.id,
          companyName: cs.name,
          message: 'Empresa suspendida',
        });
      }
    }

    return {
      companies: companyStats,
      totals,
      weeklyChart,
      alerts,
      warningMessage: account.warningMessage || null,
    };
  }

  private async getWeeklyChartMulti(companyIds: number[]) {
    const now = new Date();
    const days: { name: string; date: string; docs: number }[] = [];

    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

      const count = await this.documentRepo.count({
        where: { companyId: In(companyIds), createdAt: Between(dayStart, dayEnd) },
      });

      days.push({
        name: DAY_NAMES[dayStart.getDay()],
        date: dayStart.toISOString().split('T')[0],
        docs: count,
      });
    }

    return days;
  }

  private async getWeeklyChart(companyId: number) {
    const now = new Date();
    const days: { name: string; date: string; docs: number }[] = [];

    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dayStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );
      const dayEnd = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        23,
        59,
        59,
        999,
      );

      const count = await this.documentRepo.count({
        where: { companyId, createdAt: Between(dayStart, dayEnd) },
      });

      days.push({
        name: DAY_NAMES[dayStart.getDay()],
        date: dayStart.toISOString().split('T')[0],
        docs: count,
      });
    }

    return days;
  }

  private async getAccountSummary(
    accountId: number,
    monthStart: Date,
    monthEnd: Date,
  ) {
    const companies = await this.companyRepo.find({
      where: { accountId, isActive: true },
      select: ['id', 'name', 'ruc'],
    });

    if (companies.length <= 1) return null;

    const companyIds = companies.map((c) => c.id);

    const [totalDocs, totalRejected, totalAmountResult] = await Promise.all([
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.companyId IN (:...ids)', { ids: companyIds })
        .andWhere(
          'doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd',
          { monthStart, monthEnd },
        )
        .getCount(),
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.companyId IN (:...ids)', { ids: companyIds })
        .andWhere('doc.status = :status', { status: DocStatus.REJECTED })
        .andWhere(
          'doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd',
          { monthStart, monthEnd },
        )
        .getCount(),
      this.documentRepo
        .createQueryBuilder('doc')
        .select('COALESCE(SUM(doc.totalAmount), 0)', 'total')
        .where('doc.companyId IN (:...ids)', { ids: companyIds })
        .andWhere('doc.status = :status', { status: DocStatus.AUTHORIZED })
        .andWhere(
          'doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd',
          { monthStart, monthEnd },
        )
        .getRawOne()
        .then((r) => Number(r?.total ?? 0)),
    ]);

    return {
      totalCompanies: companies.length,
      totalDocs,
      totalRejected,
      totalAmount: totalAmountResult,
    };
  }
}
