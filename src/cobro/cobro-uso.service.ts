import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { calcularCobro, Cobro, CompanyUsage } from './cobro.calculator';
import { PlanTier } from '../entities/enums';

/**
 * Lee el uso de una cuenta en un rango de fechas y le aplica el motor de cobro.
 * Rango: [desde, hasta) en fechas de Ecuador YYYY-MM-DD. Solo empresas activas y
 * documentos de producción.
 */
@Injectable()
export class CobroUsoService {
  constructor(private readonly dataSource: DataSource) {}

  async usage(
    accountId: number,
    desde: string,
    hasta: string,
    manager?: EntityManager,
  ): Promise<CompanyUsage[]> {
    const rows: Array<{
      companyId: number;
      name: string;
      ruc: string;
      planId: number;
      planName: string;
      planTier: PlanTier;
      planPrice: string | null;
      docLimit: number | null;
      overagePrice: string | null;
      overageEnabled: boolean;
      docsTotal: number | null;
      docsAuthorized: number | null;
    }> = await (manager ?? this.dataSource).query(
      `SELECT
         c.com_id                AS "companyId",
         COALESCE(c.com_trade_name, c.com_name) AS "name",
         c.com_ruc               AS "ruc",
         p.spl_id                AS "planId",
         p.spl_name              AS "planName",
         p.spl_tier              AS "planTier",
         p.spl_monthly_price     AS "planPrice",
         p.spl_doc_limit         AS "docLimit",
         p.spl_overage_price     AS "overagePrice",
         c.com_overage_enabled   AS "overageEnabled",
         COUNT(d.doc_id)::int    AS "docsTotal",
         COUNT(d.doc_id) FILTER (WHERE d.doc_status = 'AUTHORIZED')::int AS "docsAuthorized"
       FROM app.company c
       JOIN app.subscription_plan p ON p.spl_id = c.spl_id
       LEFT JOIN app.document d ON d.com_id = c.com_id
            AND d.doc_env = 'production'
            -- Días en hora de Ecuador, sin importar la zona horaria de la sesión de la base
            AND d.doc_created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Guayaquil'
            AND d.doc_created_at <  ($3::date)::timestamp AT TIME ZONE 'America/Guayaquil'
       WHERE c.acc_id = $1 AND c.com_is_active = true
       GROUP BY c.com_id, c.com_trade_name, c.com_name, c.com_ruc, p.spl_id, p.spl_name, p.spl_tier,
                p.spl_monthly_price, p.spl_doc_limit, p.spl_overage_price, c.com_overage_enabled
       ORDER BY c.com_id`,
      [accountId, desde, hasta],
    );
    return rows.map((r) => ({
      companyId: r.companyId,
      name: r.name,
      ruc: r.ruc,
      planId: r.planId,
      planName: r.planName,
      planTier: r.planTier,
      planPrice: Number(r.planPrice ?? 0),
      docLimit:
        r.docLimit === null || r.docLimit === undefined
          ? null
          : Number(r.docLimit),
      overagePrice: Number(r.overagePrice ?? 0),
      overageEnabled: !!r.overageEnabled,
      docsAuthorized: Number(r.docsAuthorized ?? 0),
      docsTotal: Number(r.docsTotal ?? 0),
    }));
  }

  /** Cobro de la cuenta en el rango (aplica su tarifa de integrador si la tiene). */
  async cobro(
    account: { id: number; integratorPricing?: unknown },
    desde: string,
    hasta: string,
    manager?: EntityManager,
  ): Promise<Cobro> {
    return calcularCobro(
      await this.usage(account.id, desde, hasta, manager),
      account.integratorPricing,
    );
  }
}
