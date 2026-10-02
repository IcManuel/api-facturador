/**
 * Tarifa de IVA a partir del código de porcentaje (tabla 18 del SRI).
 *
 * La tarifa NO se puede deducir dividiendo valor / baseImponible: cuando el IVA
 * se redondea a dos decimales, la división da una tarifa que no existe en el
 * catálogo del SRI y el comprobante se rechaza. Ejemplo real: base 2.50 con IVA
 * del 15% da 0.38, y 0.38 / 2.50 = 15.2%, que el SRI rechaza con
 * "La tarifa del impuesto 15.2 no es igual a la parametrizada 15.0".
 */
const TARIFA_POR_CODIGO: Record<string, number> = {
  '0': 0,    // 0%
  '2': 12,   // 12% (histórico)
  '3': 14,   // 14% (histórico)
  '4': 15,   // 15% (vigente)
  '5': 5,    // 5%
  '6': 0,    // No objeto de impuesto
  '7': 0,    // Exento de IVA
  '10': 13,  // 13%
};

/**
 * Resuelve la tarifa de un impuesto, en este orden:
 *  1. La que envía el cliente, si viene.
 *  2. La del catálogo del SRI según el código de porcentaje (solo IVA).
 *  3. Como último recurso, la calculada sobre la base, redondeada a 2 decimales.
 */
export function resolverTarifa(params: {
  codigo?: string;
  codigoPorcentaje?: string;
  baseImponible?: number;
  valor?: number;
  tarifa?: number | string | null;
}): number {
  const { codigo, codigoPorcentaje, baseImponible, valor, tarifa } = params;

  if (tarifa != null && tarifa !== '') {
    const explicita = Number(tarifa);
    if (Number.isFinite(explicita)) return explicita;
  }

  // Tabla 18 solo aplica al IVA (código de impuesto 2). ICE e IRBPNR tienen
  // porcentajes variables y no se pueden deducir del código.
  const esIva = codigo === undefined || codigo === '2';
  if (esIva && codigoPorcentaje != null) {
    const delCatalogo = TARIFA_POR_CODIGO[String(codigoPorcentaje)];
    if (delCatalogo !== undefined) return delCatalogo;
  }

  const base = Number(baseImponible);
  const val = Number(valor);
  if (Number.isFinite(base) && base > 0 && Number.isFinite(val) && val > 0) {
    return Math.round((val / base) * 10000) / 100;
  }

  return 0;
}
