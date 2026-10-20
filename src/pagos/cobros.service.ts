import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  PaymentIntent,
  INTENT_APPLICABLE,
  INTENT_KIND,
  INTENT_STATUS,
} from '../entities/payment-intent.entity';
import { Account } from '../entities/account.entity';
import { Company } from '../entities/company.entity';
import { BillingPeriod } from '../entities/billing-period.entity';
import { AccountStatus, BillingStatus, PaymentMethod } from '../entities/enums';
import { BillingService } from '../admin/billing/billing.service';
import { NotificationService } from '../notifications/notification.service';
import { recalcularBloqueo } from '../cobro/cobro-bloqueo';
import { addDays, currentCycle, ymd } from '../cobro/cobro.calendar';
import { desgloseIva } from '../cobro/cobro.calculator';
import { errMsg } from './pagos.util';

/** Un cobro que Plux confirmó (por su aviso). */
export interface CobroConfirmado {
  idTransaccion: string | null;
  token: string | null;
  montoCentavos: number;
  tarjetaMarca: string | null;
  tarjetaUltimos: string | null;
}

export type ResultadoCobro = 'APLICADA' | 'REPETIDA' | 'MONTO' | 'ERROR';

/**
 * Único lugar que aplica un pago de PagoPlux: registra los pagos en los períodos, activa la
 * cuenta al terminar la demo o la desbloquea. Siempre con lo que dice el aviso de Plux, nunca
 * con lo que reporta el navegador, y siempre con el monto que fijó el servidor.
 */
@Injectable()
export class CobrosService {
  private readonly logger = new Logger(CobrosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
  ) {}

  async aplicar(
    intentId: number,
    cobro: CobroConfirmado,
  ): Promise<ResultadoCobro> {
    const alertas: string[][] = [];
    let correo: (() => Promise<void>) | null = null;

    const resultado = await this.dataSource.transaction(
      async (manager): Promise<ResultadoCobro> => {
        const intent = await manager
          .getRepository(PaymentIntent)
          .createQueryBuilder('i')
          .setLock('pessimistic_write')
          .where('i.id = :id', { id: intentId })
          .getOne();
        if (!intent) return 'ERROR';
        const tx = cobro.idTransaccion?.slice(0, 80) ?? null;

        if (intent.status === INTENT_STATUS.PAGADO) {
          if (!tx || tx === intent.providerTxId) return 'REPETIDA';
          // Plux cobró dos veces el mismo intento (dos pestañas, reintento): se devuelve a mano
          alertas.push([
            `Doble cobro en el pago ${intent.id}`,
            `La cuenta ${intent.accountId} ya había pagado este intento (transacción ${intent.providerTxId}) y Plux avisa otro cobro aprobado (transacción ${tx}, $${(cobro.montoCentavos / 100).toFixed(2)}). Revisar en el dashboard de PagoPlux y reversar o devolver.`,
          ]);
          return 'ERROR';
        }
        if (!INTENT_APPLICABLE.includes(intent.status)) return 'REPETIDA';

        if (cobro.montoCentavos !== intent.amountCents) {
          await manager.update(
            PaymentIntent,
            { id: intent.id },
            {
              status: INTENT_STATUS.ERROR,
              message: `Plux cobró $${(cobro.montoCentavos / 100).toFixed(2)} y se esperaba $${(intent.amountCents / 100).toFixed(2)}`,
              providerTxId:
                tx && !(await this.txUsada(manager, tx, intent.id))
                  ? tx
                  : intent.providerTxId,
            },
          );
          alertas.push([
            `Monto distinto en el pago ${intent.id}`,
            `La cuenta ${intent.accountId} debía pagar $${(intent.amountCents / 100).toFixed(2)} y Plux avisa un cobro de $${(cobro.montoCentavos / 100).toFixed(2)} (transacción ${tx ?? '—'}). No se aplicó nada: revisar a mano.`,
          ]);
          return 'MONTO';
        }
        if (tx && (await this.txUsada(manager, tx, intent.id))) {
          alertas.push([
            `Transacción repetida en el pago ${intent.id}`,
            `La transacción ${tx} ya está registrada en otro pago. No se aplicó nada.`,
          ]);
          return 'ERROR';
        }

        const account = await manager.findOne(Account, {
          where: { id: intent.accountId },
        });
        if (!account) return 'ERROR';
        const reference = `PagoPlux ${tx ?? cobro.token ?? intent.clientTxId}`;
        const fecha = ymd(new Date());
        let activada = false;
        let sobrante = 0;

        if (intent.kind === INTENT_KIND.ACTIVACION) {
          await this.activar(manager, account, intent, reference, fecha);
          activada = true;
        } else {
          sobrante = await this.aplicarAPeriodos(
            manager,
            intent,
            reference,
            fecha,
          );
          if (sobrante > 0) {
            alertas.push([
              `Saldo a favor en el pago ${intent.id}`,
              `La cuenta ${account.id} (${account.name}) pagó $${(intent.amountCents / 100).toFixed(2)} con PagoPlux y, al aplicarlo, sobraron $${(sobrante / 100).toFixed(2)} (posiblemente se registró otro pago a mano mientras pagaba). Queda a favor del cliente: revisar.`,
            ]);
          }
        }
        const desbloqueada = await recalcularBloqueo(manager, account.id);

        await manager.update(
          PaymentIntent,
          { id: intent.id },
          {
            status: INTENT_STATUS.PAGADO,
            paidAt: new Date(),
            providerTxId: tx,
            voucher: cobro.token?.slice(0, 40) ?? null,
            cardBrand: cobro.tarjetaMarca,
            cardLast4: cobro.tarjetaUltimos?.slice(-4) ?? null,
            message: null,
          },
        );

        const companies = await manager.find(Company, {
          where: { accountId: account.id, isActive: true },
        });
        correo = () =>
          this.notifications.sendPaymentReceived({
            accountName: account.name,
            accountEmail: account.email,
            companyEmails: companies.map((c) => ({
              email: c.email,
              notificationEmail: c.notificationEmail,
            })),
            amount: intent.amountCents / 100,
            concepto: activada
              ? 'Activación de la cuenta (primer mes)'
              : 'Pago de su saldo pendiente',
            voucher: cobro.token,
            tarjeta: cobro.tarjetaUltimos,
            activada,
            desbloqueada: desbloqueada && !activada,
          });
        this.logger.log(
          `Pago ${intent.id} aplicado: cuenta ${account.id}, ${intent.kind}, ${intent.amountCents} centavos`,
        );
        return 'APLICADA';
      },
    );

    for (const [asunto, texto] of alertas)
      await this.notifications
        .sendPagosAlert(asunto, [texto])
        .catch(() => undefined);
    if (correo)
      await (correo as () => Promise<void>)().catch((e: unknown) =>
        this.logger.warn(`Correo de pago recibido: ${errMsg(e)}`),
      );
    return resultado;
  }

  private async txUsada(
    manager: EntityManager,
    tx: string,
    intentId: number,
  ): Promise<boolean> {
    const otro = await manager.findOne(PaymentIntent, {
      where: { providerTxId: tx },
    });
    return !!otro && otro.id !== intentId;
  }

  /** Reparte el pago entre los períodos del intento, del más antiguo al más nuevo. Devuelve lo que sobra (centavos). */
  private async aplicarAPeriodos(
    manager: EntityManager,
    intent: PaymentIntent,
    reference: string,
    fecha: string,
  ): Promise<number> {
    const periods = await manager.find(BillingPeriod, {
      where: { id: In(intent.periodIds) },
      order: { dueDate: 'ASC', id: 'ASC' },
    });
    let restante = intent.amountCents;
    for (const bp of periods) {
      const saldo = Math.round(
        (Number(bp.total) - Number(bp.paidAmount)) * 100,
      );
      if (saldo <= 0 || restante <= 0) continue;
      const monto = Math.min(saldo, restante);
      await BillingService.registrarPago(manager, bp.id, {
        amount: monto / 100,
        method: PaymentMethod.PAGOPLUX,
        reference,
        notes: `Pago en línea (intento ${intent.id})`,
        date: fecha,
        recordedBy: 'PagoPlux',
        intentId: intent.id,
      });
      restante -= monto;
    }
    return restante;
  }

  /**
   * Fin de la demo: el primer mes se paga por adelantado. Queda un período ABIERTO (sin
   * cerrar) con la cuota pagada; al cerrar el ciclo se completa con los excedentes del mes.
   */
  private async activar(
    manager: EntityManager,
    account: Account,
    intent: PaymentIntent,
    reference: string,
    fecha: string,
  ) {
    if (intent.planId) {
      // Cuenta de una sola empresa que eligió plan al activarse
      await manager.update(
        Company,
        { accountId: account.id, isActive: true },
        { planId: intent.planId },
      );
    }
    const today = new Date();
    const cycleDay = Math.min(today.getDate(), 28);
    const { start, end } = currentCycle(today, cycleDay);
    const total = intent.amountCents / 100;
    const { subtotal, iva } = desgloseIva(intent.amountCents);
    const firstCompany = await manager.findOne(Company, {
      where: { accountId: account.id, isActive: true },
      order: { id: 'ASC' },
    });

    const bp = await manager.save(
      BillingPeriod,
      manager.create(BillingPeriod, {
        accountId: account.id,
        planId: intent.planId ?? firstCompany?.planId,
        year: start.getFullYear(),
        month: start.getMonth() + 1,
        periodStartDate: ymd(start),
        periodEndDate: ymd(addDays(end, -1)),
        basePrice: total,
        total,
        subtotal,
        iva,
        paidAmount: 0,
        status: BillingStatus.PENDING,
        prepaid: true,
        closedAt: null,
        dueDate: null,
      }),
    );
    await BillingService.registrarPago(manager, bp.id, {
      amount: total,
      method: PaymentMethod.PAGOPLUX,
      reference,
      notes: `Activación de la cuenta (intento ${intent.id})`,
      date: fecha,
      recordedBy: 'PagoPlux',
      intentId: intent.id,
    });

    await manager.update(
      Account,
      { id: account.id },
      {
        status: AccountStatus.ACTIVE,
        trialEndsAt: null,
        isActive: true,
        billingCycleDay: cycleDay,
        blockedReason: null,
        paymentLock: null,
        warningMessage: null,
      },
    );
    // Desde hoy se factura la empresa
    await manager.query(
      `UPDATE app.company SET com_billing_start_date = COALESCE(com_billing_start_date, $2::date) WHERE acc_id = $1 AND com_is_active`,
      [account.id, fecha],
    );
  }
}
