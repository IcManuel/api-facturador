import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In, LessThan } from 'typeorm';
import { createHash } from 'node:crypto';
import {
  PaymentNotification,
  NotificationResult,
} from '../entities/payment-notification.entity';
import {
  PaymentIntent,
  INTENT_STATUS,
} from '../entities/payment-intent.entity';
import { NotificationService } from '../notifications/notification.service';
import { CobrosService } from './cobros.service';
import { PagosService } from './pagos.service';
import { PRODUCTO } from './pagoplux.config';
import {
  Aviso,
  ESTADOS_APROBADO,
  ESTADOS_RECHAZO,
  ESTADOS_REVERSO,
  firmaValida,
  igualesSeguro,
  leerExtras,
  limpiarAviso,
  payloadSeguro,
  errMsg,
} from './pagos.util';

export const MAX_INTENTOS_AVISO = 12;
const PENDIENTES: NotificationResult[] = ['RECIBIDA', 'SIN_PAGO'];

/**
 * Recibe los avisos de PagoPlux. Mientras AutorizadorEC use el establecimiento de Mila, el
 * aviso llega reenviado por Mila y firmado con HMAC-SHA256 del cuerpo (X-Mila-Firma); cuando
 * tenga el suyo propio, llega directo de Plux con Basic auth y desde su IP.
 * Cada aviso se registra antes de procesarse y los repetidos se reconocen por su huella.
 */
@Injectable()
export class AvisosService {
  private readonly logger = new Logger(AvisosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cobros: CobrosService,
    private readonly pagos: PagosService,
    private readonly notifications: NotificationService,
  ) {}

  /** ¿Quién manda el aviso y es auténtico? */
  autenticar(
    raw: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
    ip: string | null,
  ): 'mila' | 'plux' | null {
    const c = this.pagos.config;
    const header = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    if (c.avisos === 'mila') {
      return raw && firmaValida(c.reenvioSecreto, raw, header('x-mila-firma'))
        ? 'mila'
        : null;
    }
    // Hook directo de Plux: Basic base64(idCliente:claveSecreta) y su IP
    const auth = header('authorization') ?? '';
    const [tipo, valor] = auth.trim().split(/\s+/, 2);
    if (!/^basic$/i.test(tipo ?? '') || !valor || !c.clientId || !c.secret)
      return null;
    let decodificado = '';
    try {
      decodificado = Buffer.from(valor, 'base64').toString('utf8');
    } catch {
      return null;
    }
    if (!igualesSeguro(decodificado, `${c.clientId}:${c.secret}`)) return null;
    if (
      c.hookIps !== null &&
      !c.hookIps.includes((ip ?? '').replace(/^::ffff:/, ''))
    )
      return null;
    return 'plux';
  }

  /** Registra y procesa un aviso. Lanza solo si la base falla: así se reintenta. */
  async recibir(
    body: Record<string, unknown>,
    source: 'mila' | 'plux',
    ip: string | null,
  ): Promise<NotificationResult> {
    const aviso = limpiarAviso(body);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          aviso.idTransaccion,
          aviso.token,
          aviso.estado,
          aviso.montoCentavos,
          aviso.extras,
        ]),
      )
      .digest('hex');
    const repo = this.dataSource.getRepository(PaymentNotification);

    const inserted: { pno_id: number }[] = await this.dataSource.query(
      `INSERT INTO app.payment_notification (pno_hash, pno_source, pno_tx_id, pno_state, pno_amount_cents, pno_extras, pno_payload, pno_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (pno_hash) DO NOTHING
       RETURNING pno_id`,
      [
        hash,
        source,
        aviso.idTransaccion,
        aviso.estado,
        aviso.montoCentavos,
        aviso.extras,
        JSON.stringify(payloadSeguro(body, aviso)),
        ip?.slice(0, 60) ?? null,
      ],
    );
    let id = inserted[0]?.pno_id;
    if (!id) {
      // El mismo aviso otra vez: si ya se resolvió no se repite nada
      const prev = await repo.findOne({ where: { hash } });
      if (!prev || !PENDIENTES.includes(prev.result)) return 'REPETIDA';
      id = prev.id;
    }
    return this.procesar(id, aviso);
  }

  /** Reintenta los avisos que quedaron sin resolver (p. ej. llegaron antes que su pago). */
  async reprocesarPendientes(): Promise<void> {
    const repo = this.dataSource.getRepository(PaymentNotification);
    const filas = await repo.find({
      where: {
        result: In(PENDIENTES),
        attempts: LessThan(MAX_INTENTOS_AVISO),
        createdAt: LessThan(new Date(Date.now() - 60_000)),
      },
      take: 50,
    });
    for (const f of filas) {
      const p = f.payload ?? {};
      const aviso: Aviso = {
        idTransaccion: f.txId,
        token: (p.token as string) ?? null,
        estado: f.state,
        montoCentavos: f.amountCents,
        extras: f.extras,
        tarjetaMarca: (p.cardIssuer as string) ?? null,
        tarjetaUltimos: (p.tarjeta as string) ?? null,
      };
      try {
        const r = await this.procesar(f.id, aviso);
        if (PENDIENTES.includes(r) && f.attempts + 1 >= MAX_INTENTOS_AVISO) {
          await this.notifications.sendPagosAlert(
            'Aviso de PagoPlux sin resolver',
            [
              `La notificación ${f.id} (transacción ${f.txId ?? '—'}, estado ${f.state}, $${((f.amountCents ?? 0) / 100).toFixed(2)}, extras «${f.extras ?? ''}») no corresponde a ningún pago de AutorizadorEC tras ${MAX_INTENTOS_AVISO} intentos. Revisar en el dashboard de PagoPlux.`,
            ],
          );
        }
      } catch (e) {
        this.logger.error(`Reproceso del aviso ${f.id}: ${errMsg(e)}`);
      }
    }
  }

  private async procesar(
    id: number,
    aviso: Aviso,
  ): Promise<NotificationResult> {
    const repo = this.dataSource.getRepository(PaymentNotification);
    let r: {
      resultado: NotificationResult;
      intentId: number | null;
      detalle: string | null;
    };
    try {
      r = await this.despachar(id, aviso);
    } catch (e) {
      await repo.increment({ id }, 'attempts', 1);
      await repo.update(
        { id },
        { detail: `Error: ${errMsg(e)}`.slice(0, 500) },
      );
      throw e;
    }
    await repo.update(
      { id },
      {
        result: r.resultado,
        intentId: r.intentId,
        detail: r.detalle,
        processedAt: new Date(),
      },
    );
    await repo.increment({ id }, 'attempts', 1);
    return r.resultado;
  }

  private async despachar(
    id: number,
    a: Aviso,
  ): Promise<{
    resultado: NotificationResult;
    intentId: number | null;
    detalle: string | null;
  }> {
    const extras = leerExtras(a.extras);
    if (extras && extras.producto !== PRODUCTO) {
      return {
        resultado: 'IGNORADA',
        intentId: null,
        detalle: `Producto ${extras.producto}`,
      };
    }
    const estado = a.estado ?? '';
    if (ESTADOS_REVERSO.includes(estado)) {
      // Un cobro aplicado que se reversó: no se deshace solo; lo revisa una persona
      await this.notifications.sendPagosAlert(
        'PagoPlux avisó un reverso o anulación',
        [
          `La notificación ${id} (transacción ${a.idTransaccion ?? '—'}, extras «${a.extras ?? ''}», $${((a.montoCentavos ?? 0) / 100).toFixed(2)}) dice ${estado}. Revisar si hay que anular el pago registrado.`,
        ],
      );
      return {
        resultado: 'IGNORADA',
        intentId: null,
        detalle: `Reverso: ${estado}`,
      };
    }
    const aprobado = ESTADOS_APROBADO.includes(estado);
    const rechazado = ESTADOS_RECHAZO.includes(estado);
    if (!aprobado && !rechazado)
      return {
        resultado: 'IGNORADA',
        intentId: null,
        detalle: `Estado ${estado || 'vacío'}`,
      };
    if (aprobado && a.montoCentavos === null) {
      await this.notifications.sendPagosAlert('Aviso de cobro sin monto', [
        `La notificación ${id} dice PAGADO pero no trae un monto válido. Revisar en el dashboard.`,
      ]);
      return { resultado: 'ERROR', intentId: null, detalle: 'Monto inválido' };
    }

    // El intento se reconoce por el identificador que pusimos en PayboxExtras, o por la
    // transacción que ya registró otro aviso de Plux. Nunca por datos del navegador.
    const m = this.dataSource.manager;
    let intent: PaymentIntent | null = null;
    if (extras?.clientTxId)
      intent = await m.findOne(PaymentIntent, {
        where: { clientTxId: extras.clientTxId.slice(0, 50) },
      });
    if (!intent && a.idTransaccion)
      intent = await m.findOne(PaymentIntent, {
        where: { providerTxId: a.idTransaccion.slice(0, 80) },
      });
    if (!intent)
      return {
        resultado: 'SIN_PAGO',
        intentId: null,
        detalle: 'Sin intento de pago que coincida',
      };

    if (rechazado) {
      // Un rechazo no baja un pago REPORTADO: tras un rechazo el cliente puede reintentar con
      // otra tarjeta en el mismo modal y el navegador ya vio la aprobación posterior.
      const res = await m.update(
        PaymentIntent,
        {
          id: intent.id,
          status: In([INTENT_STATUS.PENDIENTE, INTENT_STATUS.EXPIRADO]),
        },
        {
          status: INTENT_STATUS.RECHAZADO,
          message: `PagoPlux no aprobó el cobro (${estado})`,
        },
      );
      return {
        resultado: res.affected ? 'RECHAZO' : 'REPETIDA',
        intentId: intent.id,
        detalle: null,
      };
    }

    const r = await this.cobros.aplicar(intent.id, {
      idTransaccion: a.idTransaccion,
      token: a.token,
      montoCentavos: a.montoCentavos!,
      tarjetaMarca: a.tarjetaMarca,
      tarjetaUltimos: a.tarjetaUltimos,
    });
    return { resultado: r, intentId: intent.id, detalle: null };
  }
}
