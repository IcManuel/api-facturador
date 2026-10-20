import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { RedisLockService } from '../common/services/redis-lock.service';
import { NotificationService } from '../notifications/notification.service';
import { Account } from '../entities/account.entity';
import { Company } from '../entities/company.entity';
import { AccountStatus } from '../entities/enums';
import { deudaAbierta, etapaDeCuenta } from '../cobro/cobro-bloqueo';
import { daysBetween, fromYmd } from '../cobro/cobro.calendar';
import { errMsg } from './pagos.util';

/**
 * Cobranza automática, todos los días a las 09:00 (hora de Ecuador). Calendario contado desde
 * el cierre del ciclo (cobro.calendar):
 *   cierre + 5  → correo «su pago venció hoy» (el último correo de cobro)
 *   cierre + 10 → panel bloqueado: solo puede pagar; la API sigue emitiendo. Sin correo.
 *   cierre + 20 → cuenta bloqueada (se corta la emisión por API). Sin correo.
 * Al confirmarse el pago, la cuenta se desbloquea sola (cobro-bloqueo.recalcularBloqueo).
 */
@Injectable()
export class CobranzaCron {
  private readonly logger = new Logger(CobranzaCron.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisLock: RedisLockService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron('0 9 * * *')
  async diario(): Promise<void> {
    if (!(await this.redisLock.acquire('cobranza-diaria', 600))) return;
    try {
      await this.ejecutar(new Date());
    } catch (e) {
      this.logger.error(
        `Cobranza diaria: ${errMsg(e)}`,
        e instanceof Error ? e.stack : undefined,
      );
    } finally {
      await this.redisLock.release('cobranza-diaria');
    }
  }

  async ejecutar(today: Date) {
    const m = this.dataSource.manager;
    const ids: { acc_id: number }[] = await m.query(
      `SELECT DISTINCT a.acc_id
       FROM app.account a
       JOIN app.billing_period bp ON bp.acc_id = a.acc_id
       WHERE a.acc_is_internal = false AND a.acc_is_active = true
         AND a.acc_status = 'active'
         AND bp.bpe_closed_at IS NOT NULL
         AND bp.bpe_status IN ('pending', 'partial', 'overdue')
         AND bp.bpe_total > COALESCE(bp.bpe_paid_amount, 0)`,
    );

    const avisados: string[] = [];
    const panel: string[] = [];
    const cortadas: string[] = [];
    for (const { acc_id } of ids) {
      const account = await m.findOne(Account, { where: { id: acc_id } });
      if (!account) continue;
      const deuda = await deudaAbierta(m, acc_id);
      const { etapa, fechas } = etapaDeCuenta(deuda, today);
      if (!fechas) continue;
      const saldo =
        Math.round(deuda.reduce((s, d) => s + d.balance, 0) * 100) / 100;
      const linea = `${account.name} (cuenta ${account.id}) — $${saldo.toFixed(2)}, vencido el ${fechas.vence.split('-').reverse().join('/')}`;

      if (
        etapa === 'vencido' &&
        daysBetween(fromYmd(fechas.vence), today) === 0 &&
        !account.paymentLock
      ) {
        const companies = await m.find(Company, {
          where: { accountId: acc_id, isActive: true },
        });
        await this.notifications
          .sendCobroVencido({
            accountName: account.name,
            accountEmail: account.email,
            companyEmails: companies.map((c) => ({
              email: c.email,
              notificationEmail: c.notificationEmail,
            })),
            balance: saldo,
            bloqueoPanel: fechas.bloqueoPanel,
            corteApi: fechas.corteApi,
          })
          .catch((e: unknown) =>
            this.logger.warn(`Correo de vencimiento a ${acc_id}: ${errMsg(e)}`),
          );
        avisados.push(linea);
      } else if (etapa === 'panel_bloqueado' && !account.paymentLock) {
        await m.update(Account, { id: acc_id }, { paymentLock: 'panel' });
        panel.push(linea);
      } else if (etapa === 'api_cortada') {
        await m.update(
          Account,
          { id: acc_id },
          {
            status: AccountStatus.BLOCKED,
            blockedReason: 'mora',
            paymentLock: 'panel',
          },
        );
        cortadas.push(linea);
      }
    }

    if (panel.length || cortadas.length) {
      await this.notifications
        .sendPagosAlert('Bloqueos automáticos por mora', [
          ...(panel.length
            ? [
                '<strong>Panel bloqueado hoy</strong> (la API sigue emitiendo):',
                ...panel,
              ]
            : []),
          ...(cortadas.length
            ? ['<strong>Emisión por API cortada hoy</strong>:', ...cortadas]
            : []),
          'Se desbloquean solas apenas paguen con PagoPlux, o al registrar el pago a mano en Facturación.',
        ])
        .catch(() => undefined);
    }
    this.logger.log(
      `Cobranza diaria: ${ids.length} con deuda, ${avisados.length} avisadas, ${panel.length} panel bloqueado, ${cortadas.length} API cortada`,
    );
    return { conDeuda: ids.length, avisados, panel, cortadas };
  }
}
