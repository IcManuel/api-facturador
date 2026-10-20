// Copiado de Mila (api-mila-v4/src/common/identificacion-ec.ts), probado en sus pagos con PagoPlux.
/**
 * Validación de identificaciones de Ecuador para la factura electrónica.
 *
 * Dos niveles, a propósito:
 *  - `error`: la identificación está mal formada (largo, letras, provincia). Bloquea.
 *  - `aviso`: el dígito verificador no cuadra. NO bloquea, porque el propio SRI comunicó
 *    que los RUC de sociedades privadas, públicas y de extranjeros sin cédula no siguen
 *    ningún algoritmo y que en comprobantes electrónicos no valida el dígito verificador.
 *    Sirve para atrapar errores de tipeo sin impedir facturar a quien tiene un número válido.
 */
export type TipoIdentificacion =
  | 'CEDULA'
  | 'RUC'
  | 'PASAPORTE'
  | 'CONSUMIDOR_FINAL';

export interface ResultadoIdentificacion {
  valido: boolean;
  error?: string;
  aviso?: string;
}

export const CONSUMIDOR_FINAL_ID = '9999999999999';

/** Tipos de identificación de Mila ('1','2','3') → tipo. Cualquier otro valor es consumidor final. */

/** Provincias 01 a 24, y 30 para ecuatorianos registrados en el exterior. */
function provinciaValida(dosDigitos: string): boolean {
  const p = Number(dosDigitos);
  return (p >= 1 && p <= 24) || p === 30;
}

/** Módulo 10: cédulas y RUC de personas naturales. */
export function digitoModulo10(nueve: string): number {
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(nueve[i]) * (i % 2 === 0 ? 2 : 1);
    if (v > 9) v -= 9;
    suma += v;
  }
  return (10 - (suma % 10)) % 10;
}

/** Módulo 11 con los coeficientes dados; devuelve null cuando el resultado no es un dígito válido. */
function digitoModulo11(
  digitos: string,
  coeficientes: number[],
): number | null {
  const suma = coeficientes.reduce((s, c, i) => s + c * Number(digitos[i]), 0);
  const r = suma % 11;
  if (r === 0) return 0;
  if (r === 1) return null;
  return 11 - r;
}

export function validarCedula(valor: string): ResultadoIdentificacion {
  const v = (valor ?? '').trim();
  if (!/^\d+$/.test(v))
    return { valido: false, error: 'La cédula solo lleva números' };
  if (v.length !== 10)
    return {
      valido: false,
      error: `La cédula tiene 10 dígitos (ingresaste ${v.length})`,
    };
  if (!provinciaValida(v.slice(0, 2)))
    return {
      valido: false,
      error:
        'Los dos primeros dígitos de la cédula no corresponden a una provincia',
    };
  if (/^(\d)\1{9}$/.test(v))
    return {
      valido: false,
      error: 'La cédula no puede ser un mismo dígito repetido',
    };
  if (Number(v[2]) > 5 || digitoModulo10(v) !== Number(v[9])) {
    return {
      valido: true,
      aviso:
        'El dígito verificador de la cédula no coincide. Revisa el número; si es correcto, puedes continuar.',
    };
  }
  return { valido: true };
}

export function validarRuc(valor: string): ResultadoIdentificacion {
  const v = (valor ?? '').trim();
  if (!/^\d+$/.test(v))
    return { valido: false, error: 'El RUC solo lleva números' };
  if (v.length !== 13)
    return {
      valido: false,
      error: `El RUC tiene 13 dígitos (ingresaste ${v.length})`,
    };
  if (v === CONSUMIDOR_FINAL_ID)
    return {
      valido: false,
      error: 'Ese número es el de consumidor final, no un RUC',
    };
  if (!provinciaValida(v.slice(0, 2)))
    return {
      valido: false,
      error: 'Los dos primeros dígitos del RUC no corresponden a una provincia',
    };
  if (v.slice(10) === '000')
    return {
      valido: false,
      error: 'El RUC debe terminar en 001 o en el número de establecimiento',
    };

  const tercero = Number(v[2]);
  let cuadra: boolean;
  if (tercero < 6)
    cuadra = digitoModulo10(v) === Number(v[9]); // persona natural
  else if (tercero === 6)
    cuadra = digitoModulo11(v, [3, 2, 7, 6, 5, 4, 3, 2]) === Number(v[8]); // entidad pública
  else if (tercero === 9)
    cuadra = digitoModulo11(v, [4, 3, 2, 7, 6, 5, 4, 3, 2]) === Number(v[9]); // sociedad privada
  else cuadra = false;

  return cuadra
    ? { valido: true }
    : {
        valido: true,
        aviso:
          'El dígito verificador del RUC no coincide. Revisa el número; si es correcto, puedes continuar.',
      };
}

export function validarPasaporte(valor: string): ResultadoIdentificacion {
  const v = (valor ?? '').trim();
  if (v.length < 3)
    return {
      valido: false,
      error: 'El pasaporte debe tener al menos 3 caracteres',
    };
  if (v.length > 20)
    return { valido: false, error: 'El pasaporte admite hasta 20 caracteres' };
  if (!/^[A-Za-z0-9-]+$/.test(v))
    return {
      valido: false,
      error: 'El pasaporte solo lleva letras, números y guiones',
    };
  return { valido: true };
}

export function validarIdentificacion(
  tipo: TipoIdentificacion,
  valor: string,
): ResultadoIdentificacion {
  switch (tipo) {
    case 'CEDULA':
      return validarCedula(valor);
    case 'RUC':
      return validarRuc(valor);
    case 'PASAPORTE':
      return validarPasaporte(valor);
    default:
      return { valido: true };
  }
}
