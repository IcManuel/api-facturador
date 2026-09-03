/**
 * Validación de cédula y RUC ecuatorianos.
 *
 * Para RUC se evalúan TODAS las reglas aplicables (persona natural, sector
 * público, sociedad privada) en vez de decidir por el tercer dígito: el
 * Registro Civil emite cédulas de extranjero con 6 o 9 en la tercera
 * posición, así que esa cédula + "001" es un RUC de persona natural con la
 * misma forma que uno de sociedad — decidir por el tercer dígito lo manda a
 * la regla equivocada y rechaza un RUC real sin ningún error visible.
 */

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value);
}

function hasValidProvince(digits: string): boolean {
  const province = Number(digits.slice(0, 2));
  return province >= 1 && province <= 24;
}

export function isValidCedula(value: string): boolean {
  if (!isNumeric(value) || value.length !== 10) return false;
  if (!hasValidProvince(value)) return false;

  const digits = value.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    if (i % 2 === 0) {
      // posiciones impares (1.ª, 3.ª, 5.ª, 7.ª, 9.ª) → índice par
      let doubled = digits[i] * 2;
      if (doubled > 9) doubled -= 9;
      sum += doubled;
    } else {
      sum += digits[i];
    }
  }
  const nextTen = Math.ceil(sum / 10) * 10;
  const verifier = nextTen - sum === 10 ? 0 : nextTen - sum;
  return verifier === digits[9];
}

function isValidRucPersonaNatural(value: string): boolean {
  return value.endsWith('001') && isValidCedula(value.slice(0, 10));
}

function isValidRucSectorPublico(value: string): boolean {
  if (value[2] !== '6') return false;
  if (!hasValidProvince(value)) return false;

  const digits = value.split('').map(Number);
  const coefficients = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = coefficients.reduce((acc, c, i) => acc + c * digits[i], 0);
  const remainder = sum % 11;
  const verifier = remainder === 0 ? 0 : 11 - remainder;
  return verifier === digits[8];
}

function isValidRucSociedadPrivada(value: string): boolean {
  if (value[2] !== '9') return false;
  if (!hasValidProvince(value)) return false;

  const digits = value.split('').map(Number);
  const coefficients = [4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = coefficients.reduce((acc, c, i) => acc + c * digits[i], 0);
  const remainder = sum % 11;
  let verifier = 11 - remainder;
  if (verifier === 11) verifier = 0;
  return verifier === digits[9];
}

export function isValidRuc(value: string): boolean {
  if (!isNumeric(value) || value.length !== 13) return false;

  return (
    isValidRucPersonaNatural(value) ||
    isValidRucSectorPublico(value) ||
    isValidRucSociedadPrivada(value)
  );
}

export function isValidCedulaOrRuc(value: string): boolean {
  if (value.length === 10) return isValidCedula(value);
  if (value.length === 13) return isValidRuc(value);
  return false;
}

/** El pasaporte no tiene verificador ni longitud fija — alfanumérico de 6 a 13 caracteres. */
export function isValidPassport(value: string): boolean {
  return /^[a-zA-Z0-9]{6,13}$/.test(value);
}

/** Convención SRI: consumidor final siempre se identifica con 13 nueves. */
export const CONSUMIDOR_FINAL_ID = '9999999999999';

/**
 * Valida una identificación ecuatoriana según su tipo SRI (tabla 6):
 * 04=RUC, 05=Cédula, 06=Pasaporte, 07=Consumidor Final, 08=Id. Exterior.
 * Para 08 (identificación de exterior, sin formato fijo definido por el SRI)
 * solo se exige que no esté vacía — no hay una regla de verificación que
 * imponer sin arriesgar rechazar identificaciones extranjeras legítimas.
 */
export function isValidIdentification(tipo: string, value: string): boolean {
  switch (tipo) {
    case '04':
      return isValidRuc(value);
    case '05':
      return isValidCedula(value);
    case '06':
      return isValidPassport(value);
    case '07':
      return value === CONSUMIDOR_FINAL_ID;
    case '08':
      return value.trim().length > 0;
    default:
      return false;
  }
}
