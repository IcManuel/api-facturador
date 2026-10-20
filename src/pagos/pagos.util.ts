import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Mensaje de un error capturado, sin suponer su tipo. */
export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const soloDigitos = (v: string) => (v ?? '').replace(/\D/g, '');

/** El script de Plux interpreta «#» y «,» como selectores de jQuery: se quitan de los textos. */
export const textoParaPlux = (v: string) =>
  (v ?? '').replace(/[#,]/g, ' ').replace(/\s+/g, ' ').trim();

export const monto2 = (centavos: number) => (centavos / 100).toFixed(2);

/** Celular ecuatoriano en formato internacional: 0991234567 o 991234567 → +593991234567. */
export function normalizarCelular(v: string): string | null {
  let d = soloDigitos(v);
  if (d.startsWith('593')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^9\d{8}$/.test(d) ? `+593${d}` : null;
}

/** Huella de una cédula/RUC para cruzar avisos sin guardar la identificación en claro. */
export function huellaIdentificacion(ident: string): string {
  return createHash('sha256')
    .update(`plux-ident:${soloDigitos(ident)}`)
    .digest('hex')
    .slice(0, 32);
}

/** "83.25", 83.25 o "83,25" → 8325 centavos. null si no es un monto válido. */
/** Solo textos y números (lo que manda Plux); cualquier otra cosa se ignora. */
const comoTexto = (v: unknown): string | null =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : null;

export function aCentavos(v: unknown): number | null {
  const s = comoTexto(v);
  if (s === null || s === '') return null;
  const n = Number(s.replace(',', '.').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Compara dos textos en tiempo constante. */
export function igualesSeguro(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Firma con la que Mila reenvía los avisos (HMAC-SHA256 del cuerpo crudo, en hex). */
export function firmaReenvio(secreto: string, cuerpo: string | Buffer): string {
  return createHmac('sha256', secreto).update(cuerpo).digest('hex');
}

export function firmaValida(
  secreto: string,
  cuerpo: string | Buffer,
  firma: string | undefined,
): boolean {
  if (!secreto || !firma || !/^[0-9a-f]{64}$/i.test(firma.trim())) return false;
  return igualesSeguro(
    firmaReenvio(secreto, cuerpo),
    firma.trim().toLowerCase(),
  );
}

const texto = (v: unknown, max: number): string | null => {
  const t = comoTexto(v)?.trim();
  return t ? t.slice(0, max) : null;
};

/** Lo que nos sirve de un aviso de Plux, ya limpio. */
export interface Aviso {
  idTransaccion: string | null;
  token: string | null;
  estado: string | null;
  montoCentavos: number | null;
  extras: string | null;
  tarjetaMarca: string | null;
  tarjetaUltimos: string | null;
}

export function limpiarAviso(body: Record<string, unknown>): Aviso {
  const tarjeta = texto(body.cardInfo, 40);
  const digitos = tarjeta ? tarjeta.replace(/\D/g, '') : '';
  return {
    idTransaccion: texto(
      body.id_transaccion ?? body.idTransaccion ?? body.idTransaction,
      80,
    ),
    token: texto(body.token ?? body.tknPayment, 40),
    estado: texto(body.state, 20)?.toUpperCase() ?? null,
    montoCentavos: aCentavos(body.amount),
    extras: texto(body.extras, 300),
    tarjetaMarca: texto(body.cardIssuer, 80),
    tarjetaUltimos: digitos
      ? digitos.slice(-4)
      : (texto(body.tarjeta, 4) ?? null),
  };
}

/**
 * Lo que se guarda del aviso: sin cédula ni nombre del tarjetahabiente, tarjeta solo con los
 * 4 últimos, cédula solo como huella.
 */
export function payloadSeguro(body: Record<string, unknown>, a: Aviso) {
  const ident = texto(body.clientID ?? body.clientId, 20);
  return {
    ident: ident
      ? huellaIdentificacion(ident)
      : (texto(body.ident, 64) ?? null),
    id_transaccion: a.idTransaccion,
    token: a.token,
    state: a.estado,
    amount: texto(body.amount, 20),
    cardIssuer: a.tarjetaMarca,
    cardType: texto(body.cardType, 20),
    tarjeta: a.tarjetaUltimos,
    date: texto(body.date ?? body.fecha, 40),
    typePayment: texto(body.typePayment ?? body.tipoPago, 20),
    bank: texto(body.bank, 80),
    detail: texto(body.detail, 250),
    extras: a.extras,
  };
}

/** Extras de AutorizadorEC: "autorizadorec|<clientTxId>". */
export function leerExtras(
  extras: string | null,
): { producto: string; clientTxId: string | null } | null {
  if (!extras) return null;
  const partes = extras.split('|').map((x) => x.trim());
  if (partes.length < 2 || !/^[a-z0-9_-]{2,20}$/i.test(partes[0])) return null;
  return { producto: partes[0].toLowerCase(), clientTxId: partes[1] || null };
}

export const ESTADOS_APROBADO = ['PAGADO'];
export const ESTADOS_RECHAZO = [
  'RECHAZADO',
  'ERROR',
  'FALLIDO',
  'DECLINADO',
  'CANCELADO',
];
export const ESTADOS_REVERSO = [
  'ANULADO',
  'ANULADA',
  'REVERSADO',
  'REVERSO',
  'REVERSADA',
];

/** Respuesta que Plux espera del hook (soporte@plux.ec, 13-oct-2026). */
export const respuestaHook = () => ({
  status: 200,
  code: 'OK',
  message: '',
  intentId: '',
  legacyStatus: 'APPLIED',
  timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
});
