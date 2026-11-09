import { desgloseIva } from '../../cobro/cobro.calculator';

export interface ClienteFilaFactura {
  accountName: string;
  accountRuc: string;
  accountEmail: string;
  accountPhone: string | null;
  accountAddress: string | null;
  companyName: string | null;
  companyTradeName: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  companyAddress: string | null;
}

export interface PagoFilaFactura {
  amount: number;
  periodStart: string | null;
  periodEnd: string | null;
}

const fecha = (ymd: string) => ymd.split('-').reverse().join('/');

function concepto(p: PagoFilaFactura, activacionPlan: string | null): string {
  const base = 'Servicio de facturación electrónica AutorizadorEC';
  const plan = activacionPlan ? `, plan ${activacionPlan} (primer mes)` : '';
  const periodo =
    p.periodStart && p.periodEnd
      ? `, período ${fecha(p.periodStart)} al ${fecha(p.periodEnd)}`
      : '';
  return `${base}${plan}${periodo}`;
}

/**
 * Datos para que el administrador emita la factura de un pago recibido. Se factura al titular
 * de la cuenta; si entre sus empresas está la de su mismo RUC, de ahí salen la razón social y
 * la dirección, que en la cuenta suelen faltar o ser un nombre informal.
 * Cada línea se desglosa por separado (IVA incluido) para que subtotal + IVA sumen el total.
 */
export function armarDatosFactura(
  cliente: ClienteFilaFactura,
  pagos: PagoFilaFactura[],
  montoIntento: number,
  activacionPlan: string | null,
) {
  const filas: PagoFilaFactura[] = pagos.length
    ? pagos
    : [{ amount: montoIntento, periodStart: null, periodEnd: null }];
  const lineas = filas.map((p) => {
    const total = Math.round(Number(p.amount) * 100);
    const { subtotal, iva } = desgloseIva(total);
    return {
      concepto: concepto(p, activacionPlan),
      subtotal,
      iva,
      total: total / 100,
    };
  });
  const enCentavos = (k: 'subtotal' | 'total') =>
    lineas.reduce((s, l) => s + Math.round(l[k] * 100), 0);
  const subtotal = enCentavos('subtotal');
  const total = enCentavos('total');

  return {
    cliente: {
      razonSocial: cliente.companyName ?? cliente.accountName,
      nombreComercial: cliente.companyTradeName,
      ruc: cliente.accountRuc,
      direccion: cliente.companyAddress ?? cliente.accountAddress,
      correo: cliente.companyEmail ?? cliente.accountEmail,
      telefono: cliente.companyPhone ?? cliente.accountPhone,
    },
    lineas,
    subtotal: subtotal / 100,
    iva: (total - subtotal) / 100,
    ivaRate: 15,
    total: total / 100,
  };
}
