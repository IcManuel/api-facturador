import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../../entities/account.entity';
import { Company } from '../../entities/company.entity';
import { Document } from '../../entities/document.entity';
import { BillingPeriod } from '../../entities/billing-period.entity';
import { Certificate } from '../../entities/certificate.entity';
import { SystemLog } from '../../entities/system-log.entity';
import { DocStatus } from '../../entities/enums';
import { ymdEc } from '../../common/utils/date.util';

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const DOC_TYPE_LABELS: Record<string, string> = {
  '01': 'Factura',
  '03': 'Liq. Compras',
  '04': 'Nota Crédito',
  '05': 'Nota Débito',
  '06': 'Guía Remisión',
  '07': 'Retención',
};

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(BillingPeriod)
    private readonly billingRepo: Repository<BillingPeriod>,
    @InjectRepository(Certificate)
    private readonly certificateRepo: Repository<Certificate>,
    @InjectRepository(SystemLog)
    private readonly logRepo: Repository<SystemLog>,
  ) {}

  async getStats() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

    const [
      totalAccounts,
      totalCompanies,
      totalDocuments,
      docsAuthorizedToday,
      recentActivity,
      weeklyChartRaw,
      avgLatencyResult,
      docsFailed,
      docsProcessing,
      revenueResult,
      topCompaniesRaw,
      docTypeDistributionRaw,
      newAccountsThisMonth,
      newCompaniesThisMonth,
      envDistributionRaw,
      docsThisMonth,
      docsAuthorizedThisMonth,
      totalAmountThisMonth,
      certsExpiringSoon,
      sriErrors1h,
      workerErrors1h,
      lastSriLog,
      lastWorkerLog,
      docsAuthorized1h,
    ] = await Promise.all([
      this.accountRepo.count({ where: { isActive: true } }),
      this.companyRepo.count({ where: { isActive: true } }),
      this.documentRepo.count(),
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.status = :status', { status: DocStatus.AUTHORIZED })
        .andWhere('doc.createdAt >= :todayStart', { todayStart })
        .getCount(),
      this.documentRepo
        .createQueryBuilder('doc')
        .leftJoinAndSelect('doc.company', 'company')
        .orderBy('doc.createdAt', 'DESC')
        .take(10)
        .getMany(),
      this.documentRepo.query(
        `SELECT
          doc_created_at::date as day,
          COUNT(*) FILTER (WHERE doc_status = 'AUTHORIZED') as authorized,
          COUNT(*) FILTER (WHERE doc_status = 'REJECTED') as rejected
        FROM app.document
        WHERE doc_created_at >= $1
        GROUP BY day
        ORDER BY day ASC`,
        [sevenDaysAgo],
      ),
      this.documentRepo
        .query(
          `SELECT AVG(sub.doc_processing_time_ms) as avg
           FROM (
             SELECT doc_processing_time_ms FROM app.document
             WHERE doc_processing_time_ms IS NOT NULL
             ORDER BY doc_created_at DESC
             LIMIT 100
           ) sub`,
        )
        .then((rows) => rows[0] ?? { avg: null }),
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.status IN (:...statuses)', {
          statuses: [DocStatus.FAILED, DocStatus.REJECTED],
        })
        .andWhere('doc.createdAt >= :twentyFourHoursAgo', { twentyFourHoursAgo })
        .getCount(),
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.status IN (:...statuses)', {
          statuses: [DocStatus.CREATED, DocStatus.PROCESSING],
        })
        .getCount(),

      // Revenue this month
      this.billingRepo
        .createQueryBuilder('bp')
        .select('COALESCE(SUM(bp.total), 0)', 'revenue')
        .where('bp.year = :year AND bp.month = :month', { year, month })
        .getRawOne()
        .then((r) => Number(r?.revenue ?? 0)),

      // Top 5 companies by doc count this month
      this.documentRepo.query(
        `SELECT c.com_id as id, c.com_name as name, c.com_ruc as ruc,
                COUNT(d.doc_id) as docs,
                COUNT(d.doc_id) FILTER (WHERE d.doc_status = 'AUTHORIZED') as authorized,
                COUNT(d.doc_id) FILTER (WHERE d.doc_status = 'REJECTED') as rejected
         FROM app.document d
         JOIN app.company c ON d.com_id = c.com_id
         WHERE d.doc_created_at >= $1 AND d.doc_created_at <= $2
         GROUP BY c.com_id, c.com_name, c.com_ruc
         ORDER BY docs DESC
         LIMIT 5`,
        [monthStart, monthEnd],
      ),

      // Doc type distribution this month
      this.documentRepo.query(
        `SELECT doc_type_code as code, COUNT(*) as count
         FROM app.document
         WHERE doc_created_at >= $1 AND doc_created_at <= $2
         GROUP BY doc_type_code
         ORDER BY count DESC`,
        [monthStart, monthEnd],
      ),

      // New accounts this month
      this.accountRepo
        .createQueryBuilder('acc')
        .where('acc.createdAt >= :monthStart', { monthStart })
        .getCount(),

      // New companies this month
      this.companyRepo
        .createQueryBuilder('co')
        .where('co.createdAt >= :monthStart', { monthStart })
        .getCount(),

      // Environment distribution
      this.documentRepo.query(
        `SELECT doc_env as env, COUNT(*) as count
         FROM app.document
         WHERE doc_created_at >= $1 AND doc_created_at <= $2
         GROUP BY doc_env`,
        [monthStart, monthEnd],
      ),

      // Total docs this month
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd', {
          monthStart,
          monthEnd,
        })
        .getCount(),

      // Authorized docs this month
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd', {
          monthStart,
          monthEnd,
        })
        .andWhere('doc.status = :status', { status: DocStatus.AUTHORIZED })
        .getCount(),

      // Total amount authorized this month
      this.documentRepo
        .createQueryBuilder('doc')
        .select('COALESCE(SUM(doc.totalAmount), 0)', 'total')
        .where('doc.createdAt >= :monthStart AND doc.createdAt <= :monthEnd', {
          monthStart,
          monthEnd,
        })
        .andWhere('doc.status = :status', { status: DocStatus.AUTHORIZED })
        .getRawOne()
        .then((r) => Number(r?.total ?? 0)),

      // Certificates expiring in next 60 days
      this.certificateRepo.query(
        `SELECT c.cer_id as id, c.cer_file_name as "fileName", c.cer_expires_at as "expiresAt",
                c.cer_subject_cn as "subjectCn", co.com_name as "companyName", co.com_ruc as "companyRuc"
         FROM app.certificate c
         JOIN app.company co ON c.com_id = co.com_id
         WHERE c.cer_is_current = true
           AND c.cer_expires_at <= (CURRENT_DATE + INTERVAL '60 days')
         ORDER BY c.cer_expires_at ASC`,
      ),

      // SRI error logs in last 1h (for health)
      this.logRepo.query(
        `SELECT COUNT(*) as count FROM app.system_log
         WHERE slg_type = 'sri' AND slg_level = 'error'
         AND slg_created_at >= $1`,
        [new Date(now.getTime() - 60 * 60 * 1000)],
      ).then((r) => Number(r[0]?.count ?? 0)),

      // Worker error logs in last 1h
      this.logRepo.query(
        `SELECT COUNT(*) as count FROM app.system_log
         WHERE slg_type = 'worker' AND slg_level = 'error'
         AND slg_created_at >= $1`,
        [new Date(now.getTime() - 60 * 60 * 1000)],
      ).then((r) => Number(r[0]?.count ?? 0)),

      // Last SRI log (to check freshness)
      this.logRepo.query(
        `SELECT slg_created_at as "createdAt" FROM app.system_log
         WHERE slg_type = 'sri'
         ORDER BY slg_created_at DESC LIMIT 1`,
      ).then((r) => r[0]?.createdAt ?? null),

      // Last worker log
      this.logRepo.query(
        `SELECT slg_created_at as "createdAt" FROM app.system_log
         WHERE slg_type = 'worker'
         ORDER BY slg_created_at DESC LIMIT 1`,
      ).then((r) => r[0]?.createdAt ?? null),

      // Docs authorized in last 1h (SRI responsiveness check)
      this.documentRepo
        .createQueryBuilder('doc')
        .where('doc.status = :status', { status: DocStatus.AUTHORIZED })
        .andWhere('doc.createdAt >= :oneHourAgo', {
          oneHourAgo: new Date(now.getTime() - 60 * 60 * 1000),
        })
        .getCount(),
    ]);

    // Build weekly chart
    const chartMap = new Map<string, { authorized: number; rejected: number }>();
    for (const row of weeklyChartRaw) {
      const dateStr =
        row.day instanceof Date
          ? ymdEc(row.day)
          : String(row.day).slice(0, 10);
      chartMap.set(dateStr, {
        authorized: Number(row.authorized) || 0,
        rejected: Number(row.rejected) || 0,
      });
    }

    const weeklyChart: {
      name: string;
      date: string;
      authorized: number;
      rejected: number;
    }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      const dateStr = ymdEc(d);
      const dayName = DAY_NAMES[d.getDay()];
      const counts = chartMap.get(dateStr) || { authorized: 0, rejected: 0 };
      weeklyChart.push({ name: dayName, date: dateStr, ...counts });
    }

    // Health statuses from real data
    const avgMs = avgLatencyResult?.avg ? Number(avgLatencyResult.avg) : 0;
    const avgSeconds = (avgMs / 1000).toFixed(2);

    // SRI health: check errors in last 1h and recent activity
    const sriHasRecentActivity = lastSriLog
      ? (now.getTime() - new Date(lastSriLog).getTime()) < 6 * 60 * 60 * 1000
      : false;
    const sriOk = (sriErrors1h as number) === 0;
    const sriStatus = !sriHasRecentActivity && totalDocuments === 0
      ? 'Sin actividad'
      : sriOk
        ? 'Operativo'
        : `${sriErrors1h} errores/1h`;

    // Worker health
    const workerHasRecentActivity = lastWorkerLog
      ? (now.getTime() - new Date(lastWorkerLog).getTime()) < 6 * 60 * 60 * 1000
      : false;
    const workerOk = (workerErrors1h as number) === 0;
    const workerStatus = !workerHasRecentActivity && totalDocuments === 0
      ? 'Sin actividad'
      : workerOk
        ? 'Operativo'
        : `${workerErrors1h} errores/1h`;

    const healthStatuses = [
      {
        label: 'SRI Producción',
        status: sriStatus,
        ok: sriOk,
      },
      {
        label: 'SRI Pruebas',
        status: sriStatus,
        ok: sriOk,
      },
      {
        label: 'Workers',
        status: workerStatus,
        ok: workerOk,
      },
      {
        label: 'Latencia Promedio',
        status: `${avgSeconds}s`,
        ok: avgMs < 5000,
      },
    ];

    // Doc type distribution with labels
    const docTypeDistribution = (docTypeDistributionRaw || []).map(
      (row: { code: string; count: string }) => ({
        code: row.code,
        label: DOC_TYPE_LABELS[row.code] || row.code,
        count: Number(row.count),
      }),
    );

    // Env distribution
    const prodDocs = (envDistributionRaw || []).find(
      (r: any) => r.env === 'production',
    );
    const testDocs = (envDistributionRaw || []).find(
      (r: any) => r.env === 'test',
    );
    const envDistribution = {
      production: Number(prodDocs?.count ?? 0),
      test: Number(testDocs?.count ?? 0),
    };

    // Top companies
    const topCompanies = (topCompaniesRaw || []).map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      ruc: row.ruc,
      docs: Number(row.docs),
      authorized: Number(row.authorized),
      rejected: Number(row.rejected),
    }));

    const successRate =
      docsThisMonth > 0
        ? Number(((docsAuthorizedThisMonth / docsThisMonth) * 100).toFixed(1))
        : 0;

    return {
      totalAccounts,
      totalCompanies,
      totalDocuments,
      docsAuthorizedToday,
      docsFailed,
      docsProcessing,
      docsThisMonth,
      docsAuthorizedThisMonth,
      successRate,
      totalAmountThisMonth,
      revenueThisMonth: revenueResult,
      newAccountsThisMonth,
      newCompaniesThisMonth,
      weeklyChart,
      docTypeDistribution,
      envDistribution,
      topCompanies,
      recentActivity,
      healthStatuses,
      certsExpiringSoon: certsExpiringSoon || [],
    };
  }
}
