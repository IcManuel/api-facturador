import { ConfigService } from '@nestjs/config';
import { desgloseIva } from '../../cobro/cobro.calculator';

/**
 * Lo que descuenta PagoPlux en cada liquidación. Valores de la liquidación PPX-LD-004316
 * (21-oct-2026, tarjeta de crédito Diners). El aviso de pago no trae estos datos, así que
 * son configurables por si cambia el contrato.
 */
export interface TarifaPlux {
  /** Comisión sobre el monto cobrado, sin su IVA. */
  comisionPct: number;
  /** IVA que Plux factura sobre su comisión. */
  ivaComisionPct: number;
  /** Retención en la fuente sobre la base sin IVA. */
  retFuentePct: number;
  /** Retención sobre el IVA cobrado al cliente. */
  retIvaPct: number;
}

export function leerTarifaPlux(config: ConfigService): TarifaPlux {
  const pct = (clave: string, porDefecto: number) => {
    const n = Number(config.get<string>(clave));
    return config.get<string>(clave) && Number.isFinite(n) ? n : porDefecto;
  };
  return {
    comisionPct: pct('PAGOPLUX_COMISION_PCT', 4.02),
    ivaComisionPct: pct('PAGOPLUX_IVA_COMISION_PCT', 15),
    retFuentePct: pct('PAGOPLUX_RET_FUENTE_PCT', 2),
    retIvaPct: pct('PAGOPLUX_RET_IVA_PCT', 100),
  };
}

export interface NetoPago {
  cobrado: number;
  iva: number;
  ingreso: number;
  comision: number;
  ivaComision: number;
  retFuente: number;
  retIva: number;
  /** Ganancia contable: ingreso sin IVA menos la comisión de Plux. */
  ganas: number;
  /** Lo que Plux acredita en el banco. */
  deposito: number;
  comisionPct: number;
}

/** Sin redondear: para sumar varios pagos antes de redondear el total. */
function netoExacto(montoCentavos: number, t: TarifaPlux) {
  const cobrado = montoCentavos / 100;
  const { subtotal: ingreso, iva } = desgloseIva(montoCentavos);
  const comision = (cobrado * t.comisionPct) / 100;
  const ivaComision = (comision * t.ivaComisionPct) / 100;
  const retFuente = (ingreso * t.retFuentePct) / 100;
  const retIva = (iva * t.retIvaPct) / 100;
  return {
    cobrado,
    iva,
    ingreso,
    comision,
    ivaComision,
    retFuente,
    retIva,
    ganas: ingreso - comision,
    deposito: cobrado - comision - ivaComision - retFuente - retIva,
  };
}

const dosDecimales = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function calcularNeto(montoCentavos: number, t: TarifaPlux): NetoPago {
  const n = netoExacto(montoCentavos, t);
  return {
    cobrado: dosDecimales(n.cobrado),
    iva: dosDecimales(n.iva),
    ingreso: dosDecimales(n.ingreso),
    comision: dosDecimales(n.comision),
    ivaComision: dosDecimales(n.ivaComision),
    retFuente: dosDecimales(n.retFuente),
    retIva: dosDecimales(n.retIva),
    ganas: dosDecimales(n.ganas),
    deposito: dosDecimales(n.deposito),
    comisionPct: t.comisionPct,
  };
}

/** Totales de varios pagos: se suma sin redondear y se redondea al final. */
export function sumarNetos(
  montosCentavos: number[],
  t: TarifaPlux,
): { ganas: number; deposito: number } {
  let ganas = 0;
  let deposito = 0;
  for (const m of montosCentavos) {
    const n = netoExacto(m, t);
    ganas += n.ganas;
    deposito += n.deposito;
  }
  return { ganas: dosDecimales(ganas), deposito: dosDecimales(deposito) };
}
