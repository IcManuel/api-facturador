import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, IsNull, LessThan } from 'typeorm';
import { RedisLockService } from '../common/services/redis-lock.service';
import { NotificationService } from '../notifications/notification.service';
import {
  PaymentIntent,
  INTENT_STATUS,
} from '../entities/payment-intent.entity';
import { AvisosService } from './avisos.service';
import { PagosService } from './pagos.service';
import { errMsg } from './pagos.util';

/** Un pago que el navegador vio aprobado y Plux no confirma en este tiempo se avisa a administración. */
export const MINUTOS_REPORTADO_SIN_CONFIRMAR = 30;

/**
 * Red de seguridad cada 10 minutos. En pago único la API de Plux no permite consultar una
 * transacción suelta: la confirmación depende del aviso. Por eso: se reintentan los avisos sin
 * resolver, se expiran los intentos abandonados y se avisa de los reportados sin confirmar
 * (el administrador puede registrar el pago a mano después de verlo en el dashboard de Plux).
 */
@Injectable()
export class RevisionPagosCron {
  private readonly logger = new Logger(RevisionPagosCron.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisLock: RedisLockService,
    private readonly avisos: AvisosService,
    private readonly pagos: PagosService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron('*/10 * * * *')
  async revisar(): Promise<void> {
    if (!(await this.redisLock.acquire('pagos-revision', 300))) return;
    try {
      await this.avisos.reprocesarPendientes();
      await this.pagos.expirarPendientes();
      await this.alertarReportados();
    } catch (e) {
      this.logger.error(`Revisión de pagos: ${errMsg(e)}`);
    } finally {
      await this.redisLock.release('pagos-revision');
    }
  }

  async alertarReportados(): Promise<void> {
    const repo = this.dataSource.getRepository(PaymentIntent);
    const sinConfirmar = await repo.find({
      where: {
        status: INTENT_STATUS.REPORTADO,
        alertedAt: IsNull(),
        reportedAt: LessThan(
          new Date(Date.now() - MINUTOS_REPORTADO_SIN_CONFIRMAR * 60_000),
        ),
      },
      relations: ['account'],
      take: 20,
    });
    for (const p of sinConfirmar) {
      await this.notifications
        .sendPagosAlert('Pago reportado sin confirmar', [
          `La cuenta ${p.accountId} (${p.account?.name ?? '—'}) vio aprobado un pago de $${(p.amountCents / 100).toFixed(2)} hace más de ${MINUTOS_REPORTADO_SIN_CONFIRMAR} minutos y PagoPlux todavía no lo confirma (intento ${p.id}, extras autorizadorec|${p.clientTxId}).`,
          'Revisar la transacción en el dashboard de PagoPlux. Si se cobró, registrar el pago a mano en Facturación; si no, no hacer nada (el intento caduca solo).',
        ])
        .catch(() => undefined);
      await repo.update({ id: p.id }, { alertedAt: new Date() });
    }
  }
}
