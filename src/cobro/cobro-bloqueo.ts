import { EntityManager } from 'typeorm';
import { Account } from '../entities/account.entity';
import { AccountStatus } from '../entities/enums';
import { etapaCobro, EtapaCobro, fechasCobro } from './cobro.calendar';

export interface DeudaPeriodo {
  id: number;
  year: number;
  month: number;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  total: number;
  paid: number;
  balance: number;
}

/** Períodos cerrados con saldo, del más antiguo al más nuevo. */
export async function deudaAbierta(
  manager: EntityManager,
  accountId: number,
): Promise<DeudaPeriodo[]> {
  const rows: Array<{
    id: number;
    year: number;
    month: number;
    periodStart: string | null;
    periodEnd: string | null;
    dueDate: string;
    total: string;
    paid: string;
  }> = await manager.query(
    `SELECT bpe_id AS id, bpe_year AS year, bpe_month AS month,
            to_char(bpe_period_start_date, 'YYYY-MM-DD') AS "periodStart",
            to_char(bpe_period_end_date, 'YYYY-MM-DD') AS "periodEnd",
            to_char(COALESCE(bpe_due_date, current_date), 'YYYY-MM-DD') AS "dueDate",
            bpe_total AS total, COALESCE(bpe_paid_amount, 0) AS paid
     FROM app.billing_period
     WHERE acc_id = $1
       AND bpe_closed_at IS NOT NULL
       AND bpe_status IN ('pending', 'partial', 'overdue')
       AND bpe_total > COALESCE(bpe_paid_amount, 0)
     ORDER BY COALESCE(bpe_due_date, current_date), bpe_id`,
    [accountId],
  );
  return rows.map((r) => {
    const total = Number(r.total);
    const paid = Number(r.paid);
    return {
      id: r.id,
      year: r.year,
      month: r.month,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      dueDate: r.dueDate,
      total,
      paid,
      balance: Math.round((total - paid) * 100) / 100,
    };
  });
}

/** Etapa de cobranza de la cuenta: la marca su deuda más antigua. */
export function etapaDeCuenta(
  deuda: DeudaPeriodo[],
  today = new Date(),
): { etapa: EtapaCobro; fechas: ReturnType<typeof fechasCobro> | null } {
  if (!deuda.length) return { etapa: 'al_dia', fechas: null };
  return {
    etapa: etapaCobro(deuda[0].dueDate, today),
    fechas: fechasCobro(deuda[0].dueDate),
  };
}

/**
 * Después de un pago (PagoPlux o registrado por el administrador) vuelve a calcular el
 * bloqueo de la cuenta: si la deuda que queda ya no justifica el bloqueo, lo levanta.
 * Solo desbloquea cuentas bloqueadas por mora (o bloqueadas a mano antes del 020, que no
 * tienen motivo); nunca las bloqueadas por administración ('manual') ni las suspendidas.
 * Devuelve true si la cuenta quedó desbloqueada.
 */
export async function recalcularBloqueo(
  manager: EntityManager,
  accountId: number,
  today = new Date(),
): Promise<boolean> {
  const account = await manager.findOne(Account, { where: { id: accountId } });
  if (!account) return false;
  const { etapa } = etapaDeCuenta(
    await deudaAbierta(manager, accountId),
    today,
  );

  let desbloqueada = false;
  const patch: Partial<Account> = {};
  if (account.paymentLock && (etapa === 'al_dia' || etapa === 'vencido')) {
    patch.paymentLock = null;
    desbloqueada = true;
  }
  const bloqueoPorDeuda =
    account.blockedReason === 'mora' || account.blockedReason === null;
  if (
    account.status === AccountStatus.BLOCKED &&
    bloqueoPorDeuda &&
    etapa !== 'api_cortada'
  ) {
    patch.status = AccountStatus.ACTIVE;
    patch.blockedReason = null;
    patch.paymentLock = etapa === 'panel_bloqueado' ? 'panel' : null;
    desbloqueada = etapa !== 'panel_bloqueado';
  }
  if (Object.keys(patch).length)
    await manager.update(Account, { id: accountId }, patch);
  return desbloqueada;
}
