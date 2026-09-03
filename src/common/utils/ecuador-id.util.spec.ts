import { isValidCedula, isValidRuc, isValidCedulaOrRuc, isValidPassport, isValidIdentification } from './ecuador-id.util';

describe('ecuador-id.util', () => {
  describe('casos obligatorios', () => {
    it.each([
      ['1763097340001', true],
      ['0964856041001', true],
      ['0190333328001', true],
      ['1710034065', true],
      ['1710034064', false],
      ['1763097340002', false],
      ['1234567890001', false],
    ])('%s → %s', (value, expected) => {
      const actual = value.length === 10 ? isValidCedula(value) : isValidRuc(value);
      expect(actual).toBe(expected);
    });
  });

  describe('isValidRuc — reglas independientes (no branch por 3er dígito)', () => {
    it('valida sociedad privada por su propia regla, no por fallback a persona natural', () => {
      // Construido con coeficientes [4,3,2,7,6,5,4,3,2] módulo 11 sobre 179213925
      expect(isValidRuc('1792139252001')).toBe(true);
    });

    it('rechaza sociedad privada con dígito verificador alterado', () => {
      expect(isValidRuc('1792139250001')).toBe(false);
    });

    it('rechaza RUC con provincia fuera de 01-24', () => {
      expect(isValidRuc('2510034065001')).toBe(false);
    });
  });

  describe('formato', () => {
    it('rechaza no numérico', () => {
      expect(isValidRuc('179213925200a')).toBe(false);
      expect(isValidCedula('171003406a')).toBe(false);
    });

    it('rechaza longitud incorrecta', () => {
      expect(isValidCedula('171003406')).toBe(false);
      expect(isValidRuc('171003406500')).toBe(false);
    });
  });

  describe('isValidCedulaOrRuc', () => {
    it('acepta cédula de 10 o RUC de 13 válidos', () => {
      expect(isValidCedulaOrRuc('1710034065')).toBe(true);
      expect(isValidCedulaOrRuc('1763097340001')).toBe(true);
    });

    it('rechaza otras longitudes', () => {
      expect(isValidCedulaOrRuc('12345')).toBe(false);
    });
  });

  describe('isValidPassport', () => {
    it('acepta alfanumérico de 6 a 13 caracteres', () => {
      expect(isValidPassport('AB123456')).toBe(true);
    });

    it('rechaza muy corto o muy largo', () => {
      expect(isValidPassport('AB12')).toBe(false);
      expect(isValidPassport('A'.repeat(14))).toBe(false);
    });
  });

  describe('isValidIdentification por tipo SRI', () => {
    it('04 RUC / 05 Cédula / 06 Pasaporte / 07 Consumidor Final', () => {
      expect(isValidIdentification('04', '1763097340001')).toBe(true);
      expect(isValidIdentification('05', '1710034065')).toBe(true);
      expect(isValidIdentification('06', 'AB123456')).toBe(true);
      expect(isValidIdentification('07', '9999999999999')).toBe(true);
      expect(isValidIdentification('07', '1234567890123')).toBe(false);
    });

    it('08 identificación de exterior solo exige no vacío', () => {
      expect(isValidIdentification('08', 'PASSPORT-XYZ')).toBe(true);
      expect(isValidIdentification('08', '')).toBe(false);
    });
  });
});
