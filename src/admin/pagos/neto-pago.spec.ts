import { calcularNeto, sumarNetos, TarifaPlux } from './neto-pago';

const tarifa: TarifaPlux = {
  comisionPct: 4.02,
  ivaComisionPct: 15,
  retFuentePct: 2,
  retIvaPct: 100,
};

describe('calcularNeto (liquidación real PPX-LD-004316)', () => {
  it('cuadra con el pago de $20,00', () => {
    expect(calcularNeto(2000, tarifa)).toMatchObject({
      ingreso: 17.39,
      iva: 2.61,
      comision: 0.8,
      ivaComision: 0.12,
      retFuente: 0.35,
      retIva: 2.61,
      deposito: 16.12,
    });
  });

  it('cuadra con el pago de $1,00', () => {
    expect(calcularNeto(100, tarifa)).toMatchObject({
      ingreso: 0.87,
      iva: 0.13,
      comision: 0.04,
      retFuente: 0.02,
      retIva: 0.13,
      deposito: 0.81,
    });
  });

  it('la ganancia es el ingreso sin IVA menos la comisión', () => {
    expect(calcularNeto(500, tarifa)).toMatchObject({ ingreso: 4.35, ganas: 4.15, deposito: 4.03 });
  });

  it('el total acreditado de la liquidación suma $16,92', () => {
    expect(sumarNetos([100, 2000], tarifa).deposito).toBe(16.92);
  });
});
