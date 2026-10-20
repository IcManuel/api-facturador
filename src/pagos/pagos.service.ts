import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, In, LessThan, MoreThanOrEqual } from 'typeorm';
import { randomBytes } from 'node:crypto';
import {
  PaymentIntent,
  INTENT_KIND,
  INTENT_STATUS,
  IntentKind,
} from '../entities/payment-intent.entity';
import { Account } from '../entities/account.entity';
import { Company } from '../entities/company.entity';
import { AccountUser } from '../entities/account-user.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { AccountStatus, PlanTier } from '../entities/enums';
import { CobroUsoService } from '../cobro/cobro-uso.service';
import { calcularCobro } from '../cobro/cobro.calculator';
import { deudaAbierta, etapaDeCuenta } from '../cobro/cobro-bloqueo';
import { leerConfigPlux, ConfigPlux, PRODUCTO } from './pagoplux.config';
import { validarCedula, validarRuc } from './identificacion-ec';
import {
  huellaIdentificacion,
  monto2,
  normalizarCelular,
  soloDigitos,
  textoParaPlux,
} from './pagos.util';

/** El modal de Plux no caduca solo: un intento sin noticias en este tiempo se da por abandonado. */
export const MINUTOS_EXPIRACION_PENDIENTE = 60;
/** Un intento pendiente con los mismos datos y de hace menos de esto se reutiliza (otra pestaña). */
const MINUTOS_REUTILIZAR_PENDIENTE = 15;
const MAX_PENDIENTES_POR_CUENTA = 5;

const MENSAJES: Record<string, string> = {
  PAGADO: 'Pago confirmado. ¡Gracias!',
  REPORTADO: 'Estamos confirmando tu pago con PagoPlux. Tarda unos segundos.',
  PENDIENTE: 'El pago todavía no se completa.',
  RECHAZADO: 'El pago no fue aprobado. No se realizó ningún cobro.',
  EXPIRADO: 'Este intento de pago ya no está activo. Inicia el pago de nuevo.',
  ERROR:
    'Hubo un problema con este pago y lo estamos revisando. Escríbenos si tienes dudas.',
};

export interface Pagador {
  identificacion: string;
  telefono: string;
  direccion: string;
  planId?: number;
}

export type Bloqueo =
  | 'ninguno'
  | 'aviso'
  | 'panel'
  | 'total'
  | 'demo'
  | 'suspendida'
  | 'bloqueada';

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);
  readonly config: ConfigPlux;

  constructor(
    private readonly dataSource: DataSource,
    private readonly cobroUso: CobroUsoService,
    configService: ConfigService,
  ) {
    this.config = leerConfigPlux(configService);
  }

  // ── Estado de cobro de la cuenta: lo pide el panel al cargar ──────────────────
  async estado(accountId: number) {
    const account = await this.dataSource.manager.findOne(Account, {
      where: { id: accountId },
    });
    if (!account) return { ok: false, msg: 'Cuenta no encontrada' };
    const deuda = await deudaAbierta(this.dataSource.manager, accountId);
    const { etapa, fechas } = etapaDeCuenta(deuda);
    const total =
      Math.round(deuda.reduce((s, d) => s + d.balance, 0) * 100) / 100;
    const demoVencida = this.esDemoPorActivar(account);

    let bloqueo: Bloqueo = 'ninguno';
    if (account.status === AccountStatus.SUSPENDED) bloqueo = 'suspendida';
    else if (demoVencida) bloqueo = 'demo';
    else if (account.status === AccountStatus.BLOCKED)
      bloqueo =
        total > 0 && account.blockedReason !== 'manual' ? 'total' : 'bloqueada';
    else if (account.paymentLock) bloqueo = 'panel';
    else if (etapa !== 'al_dia') bloqueo = 'aviso'; // vencido (el cron aplica el bloqueo a su hora)

    const enCurso = await this.dataSource.manager.findOne(PaymentIntent, {
      where: { accountId, status: INTENT_STATUS.REPORTADO },
      order: { id: 'DESC' },
    });

    const pagador = await this.pagadorSugerido(account);

    return {
      ok: true,
      bloqueo,
      pagosEnLinea: this.config.habilitado && this.config.configurado,
      montoMinimo: this.config.montoMinimoCentavos / 100,
      deuda: { total, periodos: deuda },
      fechas,
      trialEndsAt: account.trialEndsAt,
      activacion:
        account.status === AccountStatus.TRIAL || demoVencida
          ? await this.opcionesActivacion(account)
          : null,
      pagoEnCurso: enCurso ? { id: enCurso.id, estado: enCurso.status } : null,
      pagador,
    };
  }

  /**
   * Datos para precargar el formulario de quien paga: los de la cuenta y, si faltan, los de
   * su primera empresa activa. El cliente los puede cambiar (puede pagar otra persona).
   */
  private async pagadorSugerido(account: Account) {
    const company = await this.dataSource.manager.findOne(Company, {
      where: { accountId: account.id, isActive: true },
      order: { id: 'ASC' },
    });
    const valida = (v?: string | null) => {
      const d = soloDigitos(v ?? '');
      if (d.length === 13) return validarRuc(d).valido ? d : null;
      if (d.length === 10) {
        const r = validarCedula(d);
        return r.valido && !r.aviso ? d : null;
      }
      return null;
    };
    const celular = (v?: string | null) =>
      normalizarCelular(v ?? '') ? (v ?? '').trim() : null;
    return {
      identificacion: valida(account.ruc) ?? valida(company?.ruc) ?? '',
      telefono: celular(account.phone) ?? celular(company?.phone) ?? '',
      direccion: (account.address || company?.address || '')
        .trim()
        .slice(0, 200),
    };
  }

  /** Demo vencida (o bloqueada por la demo): se activa pagando el primer mes. */
  private esDemoPorActivar(account: Account): boolean {
    if (
      account.status === AccountStatus.BLOCKED &&
      account.blockedReason === 'demo'
    )
      return true;
    return (
      account.status === AccountStatus.TRIAL &&
      !!account.trialEndsAt &&
      new Date() > new Date(account.trialEndsAt)
    );
  }

  private async planesActivables(): Promise<SubscriptionPlan[]> {
    const planes = await this.dataSource.manager.find(SubscriptionPlan, {
      where: { isActive: true },
      order: { monthlyPrice: 'ASC' },
    });
    return planes.filter(
      (p) =>
        Number(p.monthlyPrice) > 0 &&
        p.tier !== PlanTier.UNLIMITED &&
        p.tier !== PlanTier.CUSTOM,
    );
  }

  /** Planes y montos para activar la cuenta. Una cuenta de una empresa elige plan; con varias se mantienen los suyos. */
  private async opcionesActivacion(account: Account) {
    // Empresas activas sin uso (rango vacío): la activación cobra solo la cuota del primer mes
    const usage = await this.cobroUso.usage(
      account.id,
      '1900-01-01',
      '1900-01-02',
    );
    const planes = await this.planesActivables();
    const puedeElegir = usage.length === 1 && !account.integratorPricing;
    const montoActual = calcularCobro(usage, account.integratorPricing).total;
    return {
      empresas: usage.length,
      puedeElegirPlan: puedeElegir,
      planActualId: usage[0]?.planId ?? null,
      montoActual,
      planes: planes.map((p) => ({
        id: p.id,
        name: p.name,
        tier: p.tier,
        price: Number(p.monthlyPrice),
        docLimit: p.docLimit,
        overagePrice: Number(p.overagePrice ?? 0),
        features: p.features,
      })),
    };
  }

  // ── Crear el intento: el monto lo pone el servidor ─────────────────────────────
  async crear(accountId: number, userId: number, pagador: Pagador) {
    const c = this.config;
    if (!c.habilitado || !c.configurado)
      return {
        ok: false,
        msg: 'Los pagos en línea no están disponibles en este momento. Escríbenos para coordinar el pago.',
      };

    const m = this.dataSource.manager;
    const account = await m.findOne(Account, { where: { id: accountId } });
    if (!account) return { ok: false, msg: 'Cuenta no encontrada' };
    if (account.status === AccountStatus.SUSPENDED || account.isInternal)
      return {
        ok: false,
        msg: 'Esta cuenta no puede pagar en línea. Escríbenos.',
      };
    if (
      account.status === AccountStatus.BLOCKED &&
      account.blockedReason === 'manual'
    )
      return {
        ok: false,
        msg: 'Su cuenta está bloqueada. Escríbenos para revisarla.',
      };

    // Pagador: Plux valida la cédula contra el Registro Civil y exige celular y dirección
    const ident = soloDigitos(pagador.identificacion ?? '');
    const valida =
      ident.length === 13 ? validarRuc(ident) : validarCedula(ident);
    if (!valida.valido || (ident.length !== 13 && valida.aviso))
      return {
        ok: false,
        msg: 'La cédula o el RUC de quien paga no es válido. Revisa el número.',
      };
    const telefono = normalizarCelular(pagador.telefono ?? '');
    if (!telefono)
      return {
        ok: false,
        msg: 'Escribe un número de celular válido (por ejemplo 0991234567).',
      };
    const direccion = textoParaPlux(pagador.direccion ?? '');
    if (direccion.length < 5)
      return { ok: false, msg: 'Escribe la dirección de quien paga.' };

    // Qué se paga y cuánto
    let kind: IntentKind;
    let periodIds: number[] = [];
    let planId: number | null = null;
    let amountCents: number;
    let descripcion: string;
    if (
      account.status === AccountStatus.TRIAL ||
      this.esDemoPorActivar(account)
    ) {
      kind = INTENT_KIND.ACTIVACION;
      const usage = await this.cobroUso.usage(
        account.id,
        '1900-01-01',
        '1900-01-02',
      );
      if (!usage.length)
        return {
          ok: false,
          msg: 'Registre al menos una empresa antes de activar la cuenta.',
        };
      if (pagador.planId) {
        if (usage.length !== 1 || account.integratorPricing)
          return {
            ok: false,
            msg: 'Para cambiar el plan de varias empresas, escríbenos.',
          };
        const plan = (await this.planesActivables()).find(
          (p) => p.id === Number(pagador.planId),
        );
        if (!plan) return { ok: false, msg: 'Plan no válido' };
        planId = plan.id;
        usage[0] = {
          ...usage[0],
          planId: plan.id,
          planName: plan.name,
          planTier: plan.tier,
          planPrice: Number(plan.monthlyPrice),
          docLimit: plan.docLimit,
          overagePrice: Number(plan.overagePrice ?? 0),
        };
      }
      amountCents = Math.round(
        calcularCobro(usage, account.integratorPricing).total * 100,
      );
      if (amountCents <= 0)
        return {
          ok: false,
          msg: 'Su plan no tiene cuota mensual. Escríbenos para activar la cuenta.',
        };
      descripcion = 'AutorizadorEC · Activación de la cuenta (primer mes)';
    } else {
      kind = INTENT_KIND.PERIODOS;
      const deuda = await deudaAbierta(m, account.id);
      if (!deuda.length) return { ok: false, msg: 'No tiene saldo pendiente.' };
      periodIds = deuda.map((d) => d.id);
      amountCents = Math.round(deuda.reduce((s, d) => s + d.balance, 0) * 100);
      descripcion = `AutorizadorEC · Pago de ${deuda.length === 1 ? 'su período' : `${deuda.length} períodos`}`;
    }

    if (amountCents < c.montoMinimoCentavos) {
      return {
        ok: false,
        codigo: 'MONTO_MINIMO',
        msg: `El pago en línea acepta desde $${(c.montoMinimoCentavos / 100).toFixed(2)}. Su saldo de $${(amountCents / 100).toFixed(2)} se suma a su próximo cobro, o escríbanos para registrarlo.`,
      };
    }

    await this.expirarPendientes(accountId);
    const reportado = await m.findOne(PaymentIntent, {
      where: { accountId, status: INTENT_STATUS.REPORTADO },
    });
    if (reportado)
      return {
        ok: false,
        codigo: 'PAGO_EN_CONFIRMACION',
        pagoId: reportado.id,
        msg: 'Tiene un pago que estamos confirmando con PagoPlux. Espere unos minutos antes de intentar otro.',
      };
    const pendientes = await m.count(PaymentIntent, {
      where: { accountId, status: INTENT_STATUS.PENDIENTE },
    });
    if (pendientes >= MAX_PENDIENTES_POR_CUENTA)
      return {
        ok: false,
        msg: 'Tiene varios pagos iniciados sin terminar. Espere unos minutos e intente de nuevo.',
      };

    const user = await m.findOne(AccountUser, {
      where: { id: userId, accountId },
    });
    if (!user?.email)
      return { ok: false, msg: 'Su usuario no tiene correo registrado.' };

    const identHash = huellaIdentificacion(ident);
    // Mismo intento reciente con los mismos datos (otra pestaña, recargar): se reutiliza, así
    // dos modales abiertos son el MISMO pago y un segundo cobro se detecta como doble.
    const reciente = await m.findOne(PaymentIntent, {
      where: {
        accountId,
        userId,
        kind,
        status: INTENT_STATUS.PENDIENTE,
        amountCents,
        payerIdentHash: identHash,
        createdAt: MoreThanOrEqual(
          new Date(Date.now() - MINUTOS_REUTILIZAR_PENDIENTE * 60_000),
        ),
      },
      order: { id: 'DESC' },
    });
    const mismoContenido =
      reciente &&
      reciente.planId === planId &&
      [...reciente.periodIds].sort().join(',') ===
        [...periodIds].sort().join(',');
    const intent = mismoContenido
      ? reciente
      : await m.save(
          PaymentIntent,
          m.create(PaymentIntent, {
            accountId,
            userId,
            kind,
            periodIds,
            planId,
            amountCents,
            status: INTENT_STATUS.PENDIENTE,
            // Imposible de adivinar (96 bits al azar); vuelve en el aviso de Plux
            clientTxId: `AE${randomBytes(12).toString('hex')}`,
            payerEmail: user.email,
            payerIdentHash: identHash,
          }),
        );

    const nombreLimpio = textoParaPlux(user.name ?? '');
    const nombre =
      nombreLimpio.length >= 6
        ? nombreLimpio.slice(0, 60)
        : 'Cliente AutorizadorEC';
    this.logger.log(
      `Pago ${intent.id} ${mismoContenido ? 'reutilizado' : 'creado'}: cuenta ${accountId}, ${kind}, ${amountCents} centavos`,
    );
    return {
      ok: true,
      pagoId: intent.id,
      monto: amountCents / 100,
      scriptUrl: c.scriptUrl,
      paybox: {
        PayboxRemail: c.email,
        PayboxSendmail: user.email,
        PayboxRename: c.nombre,
        PayboxSendname: nombre,
        PayboxBase0: '0.00',
        PayboxBase12: monto2(amountCents),
        PayboxDescription: descripcion,
        PayboxProduction: c.produccion,
        PayboxEnvironment: c.produccion ? 'prod' : 'sandbox',
        PayboxLanguage: 'es',
        PayboxPagoPlux: true,
        PayboxDirection: direccion.slice(0, 200),
        PayBoxClientPhone: telefono,
        PayBoxClientIdentification: ident,
        PayboxExtras: `${PRODUCTO}|${intent.clientTxId}`,
        // Pago único: el monto cambia cada mes por los excedentes
        PayboxRecurrent: false,
      },
    };
  }

  // ── El navegador avisa que el modal aprobó: no activa nada ──────────────────────
  async reportar(accountId: number, intentId: number) {
    const m = this.dataSource.manager;
    const intent = await m.findOne(PaymentIntent, {
      where: { id: intentId, accountId },
    });
    if (!intent)
      return {
        ok: false,
        estado: 'DESCONOCIDO',
        msg: 'No encontramos este pago.',
      };
    // RECHAZADO también: tras un rechazo el cliente puede pagar con otra tarjeta en el mismo modal
    const reportables = [
      INTENT_STATUS.PENDIENTE,
      INTENT_STATUS.EXPIRADO,
      INTENT_STATUS.RECHAZADO,
    ];
    await m.update(
      PaymentIntent,
      { id: intent.id, status: In(reportables) },
      { status: INTENT_STATUS.REPORTADO, reportedAt: new Date() },
    );
    return this.estadoPago(accountId, intentId);
  }

  async estadoPago(accountId: number, intentId: number) {
    const intent = await this.dataSource.manager.findOne(PaymentIntent, {
      where: { id: intentId, accountId },
    });
    if (!intent)
      return {
        ok: false,
        estado: 'DESCONOCIDO',
        msg: 'No encontramos este pago.',
      };
    return {
      ok: true,
      pagoId: intent.id,
      estado: intent.status,
      tipo: intent.kind,
      monto: intent.amountCents / 100,
      msg: MENSAJES[intent.status] ?? '',
      tarjeta: intent.cardLast4,
      comprobante: intent.voucher,
    };
  }

  async expirarPendientes(accountId?: number) {
    const limite = new Date(Date.now() - MINUTOS_EXPIRACION_PENDIENTE * 60_000);
    await this.dataSource.manager.update(
      PaymentIntent,
      {
        ...(accountId ? { accountId } : {}),
        status: INTENT_STATUS.PENDIENTE,
        createdAt: LessThan(limite),
      },
      { status: INTENT_STATUS.EXPIRADO },
    );
  }
}
