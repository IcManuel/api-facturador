import {
  aCentavos,
  firmaReenvio,
  firmaValida,
  leerExtras,
  limpiarAviso,
  normalizarCelular,
  payloadSeguro,
  textoParaPlux,
} from './pagos.util';
import { validarCedula, validarRuc } from './identificacion-ec';

describe('pagos.util', () => {
  const secreto = 'a'.repeat(64);

  it('verifica la firma de Mila sobre el cuerpo crudo', () => {
    const raw = '{"state":"PAGADO","amount":"6.35"}';
    expect(firmaValida(secreto, raw, firmaReenvio(secreto, raw))).toBe(true);
    expect(firmaValida(secreto, raw + ' ', firmaReenvio(secreto, raw))).toBe(
      false,
    ); // cuerpo alterado
    expect(firmaValida(secreto, raw, firmaReenvio('b'.repeat(64), raw))).toBe(
      false,
    ); // otro secreto
    expect(firmaValida(secreto, raw, undefined)).toBe(false);
    expect(firmaValida('', raw, firmaReenvio('', raw))).toBe(false); // sin secreto configurado nunca vale
  });

  it('montos de Plux a centavos', () => {
    expect([
      aCentavos('6.35'),
      aCentavos(6.35),
      aCentavos('6,35'),
      aCentavos('30'),
      aCentavos(''),
      aCentavos('-1'),
      aCentavos('x'),
    ]).toEqual([635, 635, 635, 3000, null, null, null]);
  });

  it('extras de AutorizadorEC', () => {
    expect(leerExtras('autorizadorec|AE0011')).toEqual({
      producto: 'autorizadorec',
      clientTxId: 'AE0011',
    });
    expect(leerExtras('mila|ML1|3|mensual')?.producto).toBe('mila');
    expect(leerExtras('sin-separador')).toBeNull();
  });

  it('lo guardado del aviso no lleva cédula, nombre ni número de tarjeta', () => {
    const body = {
      clientID: '0706410164',
      clientName: 'Juan Pérez',
      cardInfo: '4540 63XX XXXX 8783',
      amount: '6.35',
      state: 'pagado',
      extras: 'autorizadorec|AE1',
    };
    const a = limpiarAviso(body);
    expect(a).toMatchObject({
      estado: 'PAGADO',
      montoCentavos: 635,
      tarjetaUltimos: '8783',
    });
    const guardado = JSON.stringify(payloadSeguro(body, a));
    expect(guardado).not.toContain('0706410164');
    expect(guardado).not.toContain('Juan');
    expect(guardado).not.toContain('4540');
  });

  it('textos para el script de Plux sin # ni ,', () => {
    expect(textoParaPlux('Av. 10 de Agosto #123, Quito')).toBe(
      'Av. 10 de Agosto 123 Quito',
    );
  });

  it('celular ecuatoriano', () => {
    expect([
      normalizarCelular('0991234567'),
      normalizarCelular('+593 99 123 4567'),
      normalizarCelular('022345678'),
    ]).toEqual(['+593991234567', '+593991234567', null]);
  });

  it('cédula y RUC (dígito verificador)', () => {
    expect(validarCedula('0706410164')).toEqual({ valido: true });
    expect(validarCedula('0706410165').aviso).toBeTruthy();
    expect(validarRuc('0706410164001')).toEqual({ valido: true });
  });
});
