import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MINUTOS_REPORTADO_SIN_CONFIRMAR } from '../../pagos/revision-pagos.cron';

/** Lo que necesita revisar el administrador: pagos con problema y avisos sin resolver. */
const AVISOS_A_REVISAR = ['SIN_PAGO', 'MONTO', 'ERROR', 'RECIBIDA'];

@Injectable()
export class PagosAdminService {
  constructor(private readonly dataSource: DataSource) {}

  async resumen() {
    const [r] = await this.dataSource.query<
      Array<{
        errores: number;
        sinConfirmar: number;
        avisos: number;
        pagadosMes: number;
        montoMes: string | null;
        pagadosHoy: number;
      }>
    >(
      `SELECT
         (SELECT count(*)::int FROM app.payment_intent WHERE pin_status = 'ERROR') AS "errores",
         (SELECT count(*)::int FROM app.payment_intent
            WHERE pin_status = 'REPORTADO' AND pin_reported_at < now() - make_interval(mins => $1)) AS "sinConfirmar",
         (SELECT count(*)::int FROM app.payment_notification WHERE pno_result = ANY($2)) AS "avisos",
         (SELECT count(*)::int FROM app.payment_intent
            WHERE pin_status = 'PAGADO' AND pin_paid_at >= date_trunc('month', now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil') AS "pagadosMes",
         (SELECT sum(pin_amount_cents) / 100.0 FROM app.payment_intent
            WHERE pin_status = 'PAGADO' AND pin_paid_at >= date_trunc('month', now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil') AS "montoMes",
         (SELECT count(*)::int FROM app.payment_intent
            WHERE pin_status = 'PAGADO' AND pin_paid_at >= date_trunc('day', now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil') AS "pagadosHoy"`,
      [MINUTOS_REPORTADO_SIN_CONFIRMAR, AVISOS_A_REVISAR],
    );
    return {
      ...r,
      montoMes: Number(r.montoMes ?? 0),
      minutosSinConfirmar: MINUTOS_REPORTADO_SIN_CONFIRMAR,
    };
  }

  async intentos(f: {
    status?: string;
    accountId?: number;
    page: number;
    limit: number;
  }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.status === 'REVISAR') {
      params.push(MINUTOS_REPORTADO_SIN_CONFIRMAR);
      where.push(
        `(i.pin_status = 'ERROR' OR (i.pin_status = 'REPORTADO' AND i.pin_reported_at < now() - make_interval(mins => $${params.length})))`,
      );
    } else if (f.status) {
      params.push(f.status);
      where.push(`i.pin_status = $${params.length}`);
    }
    if (f.accountId) {
      params.push(f.accountId);
      where.push(`i.acc_id = $${params.length}`);
    }
    const filtro = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = await this.dataSource.query<Array<{ total: number }>>(
      `SELECT count(*)::int AS total FROM app.payment_intent i ${filtro}`,
      params,
    );
    params.push(f.limit, (f.page - 1) * f.limit);
    const data = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT i.pin_id AS id, i.acc_id AS "accountId", a.acc_name AS "accountName", i.pin_kind AS kind,
              i.pin_period_ids AS "periodIds", i.pin_amount_cents / 100.0 AS amount, i.pin_status AS status,
              i.pin_client_tx_id AS "clientTxId", i.pin_provider_tx_id AS "providerTxId", i.pin_voucher AS voucher,
              i.pin_card_brand AS "cardBrand", i.pin_card_last4 AS "cardLast4", i.pin_message AS message,
              i.pin_payer_email AS "payerEmail", i.pin_created_at AS "createdAt", i.pin_reported_at AS "reportedAt",
              i.pin_paid_at AS "paidAt", i.pin_alerted_at AS "alertedAt"
       FROM app.payment_intent i JOIN app.account a ON a.acc_id = i.acc_id
       ${filtro}
       ORDER BY i.pin_id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      data: data.map((d) => ({ ...d, amount: Number(d.amount) })),
      total,
      page: f.page,
      limit: f.limit,
      totalPages: Math.ceil(total / f.limit),
    };
  }

  async intento(id: number) {
    const { data } = await this.intentosPorId(id);
    if (!data) throw new NotFoundException('Pago no encontrado');
    const avisos = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT pno_id AS id, pno_source AS source, pno_state AS state, pno_amount_cents / 100.0 AS amount, pno_tx_id AS "txId",
              pno_result AS result, pno_detail AS detail, pno_attempts AS attempts, pno_created_at AS "createdAt"
       FROM app.payment_notification WHERE pin_id = $1 OR pno_extras = $2 ORDER BY pno_id`,
      [id, `autorizadorec|${String(data.clientTxId)}`],
    );
    const pagos = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT p.pay_id AS id, p.bpe_id AS "periodId", p.pay_amount AS amount, p.pay_reference AS reference, p.pay_date AS date,
              bp.bpe_period_start_date AS "periodStart", bp.bpe_period_end_date AS "periodEnd"
       FROM app.payment p JOIN app.billing_period bp ON bp.bpe_id = p.bpe_id
       WHERE p.pin_id = $1 ORDER BY p.pay_id`,
      [id],
    );
    return {
      ...data,
      avisos: avisos.map((a) => ({
        ...a,
        amount: a.amount === null ? null : Number(a.amount),
      })),
      pagos,
    };
  }

  private async intentosPorId(
    id: number,
  ): Promise<{ data: Record<string, unknown> | null }> {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT i.pin_id AS id, i.acc_id AS "accountId", a.acc_name AS "accountName", i.pin_kind AS kind,
              i.pin_amount_cents / 100.0 AS amount, i.pin_status AS status, i.pin_client_tx_id AS "clientTxId",
              i.pin_provider_tx_id AS "providerTxId", i.pin_voucher AS voucher, i.pin_card_last4 AS "cardLast4",
              i.pin_message AS message, i.pin_created_at AS "createdAt", i.pin_paid_at AS "paidAt"
       FROM app.payment_intent i JOIN app.account a ON a.acc_id = i.acc_id WHERE i.pin_id = $1`,
      [id],
    );
    return {
      data: rows[0] ? { ...rows[0], amount: Number(rows[0].amount) } : null,
    };
  }

  async avisos(f: { result?: string; page: number; limit: number }) {
    const params: unknown[] = [];
    let filtro = '';
    if (f.result === 'REVISAR') {
      params.push(AVISOS_A_REVISAR);
      filtro = `WHERE n.pno_result = ANY($1)`;
    } else if (f.result) {
      params.push(f.result);
      filtro = `WHERE n.pno_result = $1`;
    }
    const [{ total }] = await this.dataSource.query<Array<{ total: number }>>(
      `SELECT count(*)::int AS total FROM app.payment_notification n ${filtro}`,
      params,
    );
    params.push(f.limit, (f.page - 1) * f.limit);
    const data = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT n.pno_id AS id, n.pno_source AS source, n.pno_state AS state, n.pno_amount_cents / 100.0 AS amount,
              n.pno_tx_id AS "txId", n.pno_extras AS extras, n.pno_result AS result, n.pno_detail AS detail,
              n.pno_attempts AS attempts, n.pin_id AS "intentId", i.acc_id AS "accountId", a.acc_name AS "accountName",
              n.pno_created_at AS "createdAt", n.pno_processed_at AS "processedAt"
       FROM app.payment_notification n
       LEFT JOIN app.payment_intent i ON i.pin_id = n.pin_id
       LEFT JOIN app.account a ON a.acc_id = i.acc_id
       ${filtro}
       ORDER BY n.pno_id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      data: data.map((d) => ({
        ...d,
        amount: d.amount === null ? null : Number(d.amount),
      })),
      total,
      page: f.page,
      limit: f.limit,
      totalPages: Math.ceil(total / f.limit),
    };
  }
}
