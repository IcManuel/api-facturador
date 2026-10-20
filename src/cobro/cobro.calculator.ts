import { PlanTier } from '../entities/enums';
import type { IntegratorPricingJson } from '../entities/account.entity';

/**
 * Motor único de cobro de AutorizadorEC. Lo usan el cierre del ciclo, la generación manual,
 * el reporte de cobros, el detalle del administrador y la vista del cliente: todos muestran y
 * cobran exactamente lo mismo.
 *
 * Reglas (Manuel, 19-oct-2026):
 *  - Precios con IVA INCLUIDO (15 %). El total es lo que paga el cliente; subtotal e IVA son
 *    el desglose (subtotal = total / 1,15).
 *  - Cuota de cada empresa ACTIVA, emita o no.
 *  - Solo documentos AUTORIZADOS en producción (los de pruebas nunca se cobran).
 *  - Planes fijos: excedente = autorizados sobre el límite, solo si la empresa lo tiene habilitado.
 *  - Bajo Demanda: cuota base del plan + cada autorizado.
 *  - Ilimitado: sin cargo.
 *  - Integrador (tarifa propia de la cuenta): precio por empresa según el tramo del número de
 *    empresas activas, más un valor por documento autorizado. Reemplaza al plan de cada empresa.
 *
 * Todo se calcula en centavos para no arrastrar errores de redondeo.
 */

export const IVA_RATE = 15;

export interface CompanyUsage {
  companyId: number;
  name: string;
  ruc: string;
  planId: number;
  planName: string;
  planTier: PlanTier;
  /** Cuota mensual del plan, con IVA. */
  planPrice: number;
  docLimit: number | null;
  /** Precio por documento extra, con IVA. */
  overagePrice: number;
  overageEnabled: boolean;
  /** Documentos de producción AUTORIZADOS en el período. */
  docsAuthorized: number;
  /** Todos los documentos de producción del período (solo informativo). */
  docsTotal: number;
}

export interface CobroLinea {
  companyId: number;
  name: string;
  ruc: string;
  planId: number;
  planName: string;
  docsTotal: number;
  docsAuthorized: number;
  docLimit: number | null;
  /** Cuota de la empresa (del plan o de la tarifa de integrador), con IVA. */
  base: number;
  /** Documentos que se cobran aparte (excedentes o, en Bajo Demanda, todos los autorizados). */
  overageDocs: number;
  overageUnitPrice: number;
  overageTotal: number;
  /** base + overageTotal, con IVA. */
  total: number;
}

export interface Cobro {
  lineas: CobroLinea[];
  baseTotal: number;
  overageDocs: number;
  overageTotal: number;
  docsTotal: number;
  docsAuthorized: number;
  /** Lo que paga el cliente (IVA incluido). */
  total: number;
  /** Desglose: total sin IVA. */
  subtotal: number;
  iva: number;
  ivaRate: number;
  /** Tarifa aplicada: 'planes' o 'integrador'. */
  tarifa: 'planes' | 'integrador';
  /** Con tarifa de integrador: precio por empresa del tramo aplicado. */
  precioPorEmpresa: number | null;
}

const cents = (v: number) => Math.round(Number(v) * 100);
const dollars = (c: number) => Math.round(c) / 100;

/** Valida la tarifa guardada en la cuenta; null si no hay o está mal formada. */
export function parseIntegratorPricing(
  value: unknown,
): IntegratorPricingJson | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<IntegratorPricingJson>;
  if (!Array.isArray(v.tramos) || v.tramos.length === 0) return null;
  const tramos = v.tramos
    .filter(
      (t) => t && Number.isFinite(Number(t.precio)) && Number(t.precio) >= 0,
    )
    .map((t) => ({
      hasta: t.hasta === null || t.hasta === undefined ? null : Number(t.hasta),
      precio: Number(t.precio),
    }))
    .sort((a, b) => (a.hasta ?? Infinity) - (b.hasta ?? Infinity));
  if (!tramos.length) return null;
  const porDocumento = Number(v.porDocumento ?? 0);
  if (!Number.isFinite(porDocumento) || porDocumento < 0) return null;
  return { tramos, porDocumento };
}

/** Precio por empresa del tramo que corresponde a `activas` empresas activas. */
export function precioDelTramo(
  pricing: IntegratorPricingJson,
  activas: number,
): number {
  const tramo =
    pricing.tramos.find((t) => t.hasta === null || activas <= t.hasta) ??
    pricing.tramos[pricing.tramos.length - 1];
  return tramo.precio;
}

/** Desglose del IVA incluido en un total en centavos. */
export function desgloseIva(
  totalCents: number,
  rate = IVA_RATE,
): { subtotal: number; iva: number } {
  const subtotalCents = Math.round(totalCents / (1 + rate / 100));
  return {
    subtotal: dollars(subtotalCents),
    iva: dollars(totalCents - subtotalCents),
  };
}

export function calcularCobro(
  companies: CompanyUsage[],
  integratorPricing?: unknown,
): Cobro {
  const pricing = parseIntegratorPricing(integratorPricing);
  const precioEmpresa = pricing
    ? precioDelTramo(pricing, companies.length)
    : null;

  const lineas: CobroLinea[] = companies.map((c) => {
    const authorized = Math.max(0, Math.trunc(Number(c.docsAuthorized) || 0));
    let baseCents = 0;
    let overageDocs = 0;
    let unitPrice = 0;

    if (pricing) {
      baseCents = cents(precioEmpresa!);
      overageDocs = authorized;
      unitPrice = pricing.porDocumento;
    } else if (c.planTier === PlanTier.UNLIMITED) {
      // sin cargo
    } else if (c.planTier === PlanTier.PAYPERUSE) {
      baseCents = cents(c.planPrice);
      overageDocs = authorized;
      unitPrice = Number(c.overagePrice || 0);
    } else {
      baseCents = cents(c.planPrice);
      unitPrice = Number(c.overagePrice || 0);
      if (c.overageEnabled && c.docLimit !== null && c.docLimit !== undefined) {
        overageDocs = Math.max(0, authorized - Number(c.docLimit));
      }
    }

    const overageCents = Math.round(overageDocs * unitPrice * 100);
    return {
      companyId: c.companyId,
      name: c.name,
      ruc: c.ruc,
      planId: c.planId,
      planName: pricing ? 'Tarifa de integrador' : c.planName,
      docsTotal: Number(c.docsTotal) || 0,
      docsAuthorized: authorized,
      docLimit: pricing ? null : c.docLimit,
      base: dollars(baseCents),
      overageDocs,
      overageUnitPrice: unitPrice,
      overageTotal: dollars(overageCents),
      total: dollars(baseCents + overageCents),
    };
  });

  const totalCents = lineas.reduce((s, l) => s + cents(l.total), 0);
  const { subtotal, iva } = desgloseIva(totalCents);
  return {
    lineas,
    baseTotal: dollars(lineas.reduce((s, l) => s + cents(l.base), 0)),
    overageDocs: lineas.reduce((s, l) => s + l.overageDocs, 0),
    overageTotal: dollars(
      lineas.reduce((s, l) => s + cents(l.overageTotal), 0),
    ),
    docsTotal: lineas.reduce((s, l) => s + l.docsTotal, 0),
    docsAuthorized: lineas.reduce((s, l) => s + l.docsAuthorized, 0),
    total: dollars(totalCents),
    subtotal,
    iva,
    ivaRate: IVA_RATE,
    tarifa: pricing ? 'integrador' : 'planes',
    precioPorEmpresa: precioEmpresa,
  };
}
