import { PlanTier } from '../entities/enums';
import {
  calcularCobro,
  CompanyUsage,
  desgloseIva,
  parseIntegratorPricing,
  precioDelTramo,
} from './cobro.calculator';

const empresa = (o: Partial<CompanyUsage> = {}): CompanyUsage => ({
  companyId: 1,
  name: 'Empresa',
  ruc: '0999999999001',
  planId: 1,
  planName: 'Básico',
  planTier: PlanTier.BASIC,
  planPrice: 5,
  docLimit: 100,
  overagePrice: 0.05,
  overageEnabled: false,
  docsAuthorized: 0,
  docsTotal: 0,
  ...o,
});

const RURAL = {
  tramos: [
    { hasta: 20, precio: 3 },
    { hasta: 50, precio: 2.5 },
    { hasta: null, precio: 2 },
  ],
  porDocumento: 0.05,
};

describe('calcularCobro', () => {
  it('cobra la cuota aunque la empresa no emita', () => {
    const c = calcularCobro([empresa()]);
    expect(c.total).toBe(5);
    expect(c.lineas[0]).toMatchObject({ base: 5, overageDocs: 0, total: 5 });
  });

  it('IVA incluido: $5,00 = $4,35 + $0,65', () => {
    const c = calcularCobro([empresa()]);
    expect(c).toMatchObject({
      total: 5,
      subtotal: 4.35,
      iva: 0.65,
      ivaRate: 15,
    });
  });

  it('el desglose siempre suma el total exacto', () => {
    for (let cents = 1; cents <= 20000; cents += 7) {
      const { subtotal, iva } = desgloseIva(cents);
      expect(Math.round((subtotal + iva) * 100)).toBe(cents);
    }
  });

  it('planes fijos: el excedente cuenta solo AUTORIZADOS', () => {
    // 130 documentos en producción, 110 autorizados (20 rechazados) con límite 100 → 10 extras
    const c = calcularCobro([
      empresa({ overageEnabled: true, docsTotal: 130, docsAuthorized: 110 }),
    ]);
    expect(c.lineas[0]).toMatchObject({
      overageDocs: 10,
      overageTotal: 0.5,
      total: 5.5,
    });
  });

  it('planes fijos: sin excedente habilitado no se cobran extras', () => {
    const c = calcularCobro([
      empresa({ overageEnabled: false, docsAuthorized: 500 }),
    ]);
    expect(c.total).toBe(5);
  });

  it('Bajo Demanda: $5 de base + $0,05 por cada autorizado', () => {
    const c = calcularCobro([
      empresa({
        planTier: PlanTier.PAYPERUSE,
        planName: 'Bajo Demanda',
        docLimit: null,
        docsAuthorized: 27,
        docsTotal: 30,
      }),
    ]);
    expect(c.lineas[0]).toMatchObject({
      base: 5,
      overageDocs: 27,
      overageTotal: 1.35,
      total: 6.35,
    });
  });

  it('Bajo Demanda antiguo (sin cuota base): solo los autorizados', () => {
    const c = calcularCobro([
      empresa({
        planTier: PlanTier.PAYPERUSE,
        planPrice: 0,
        docLimit: null,
        docsAuthorized: 1,
      }),
    ]);
    expect(c.total).toBe(0.05);
  });

  it('Ilimitado: sin cargo', () => {
    expect(
      calcularCobro([
        empresa({
          planTier: PlanTier.UNLIMITED,
          planPrice: 0,
          docsAuthorized: 9999,
        }),
      ]).total,
    ).toBe(0);
  });

  it('suma varias empresas de la cuenta sin errores de redondeo', () => {
    const c = calcularCobro([
      empresa({ companyId: 1, planPrice: 20, docLimit: 600 }),
      empresa({
        companyId: 2,
        planTier: PlanTier.PAYPERUSE,
        docLimit: null,
        docsAuthorized: 3,
      }),
      empresa({
        companyId: 3,
        planPrice: 50,
        docLimit: 2000,
        overageEnabled: true,
        docsAuthorized: 2001,
      }),
    ]);
    expect(c.total).toBe(75.2); // 20 + 5,15 + 50,05
    expect(c.baseTotal).toBe(75);
    expect(c.overageTotal).toBe(0.2);
  });

  describe('tarifa de integrador (Rural Technologies)', () => {
    const n = (k: number, docs = 0) =>
      Array.from({ length: k }, (_, i) =>
        empresa({ companyId: i + 1, docsAuthorized: docs, planPrice: 5 }),
      );

    it('1 a 20 empresas: $3 c/u', () => {
      const c = calcularCobro(n(20), RURAL);
      expect(c).toMatchObject({
        tarifa: 'integrador',
        precioPorEmpresa: 3,
        total: 60,
      });
    });

    it('21 a 50 empresas: $2,50 c/u, a TODAS (no escalonado)', () => {
      expect(calcularCobro(n(30), RURAL).total).toBe(75);
    });

    it('más de 50: $2 c/u', () => {
      expect(calcularCobro(n(51), RURAL).total).toBe(102);
    });

    it('$0,05 por documento autorizado, reemplaza el plan de cada empresa', () => {
      const c = calcularCobro(n(2, 10), RURAL);
      expect(c.total).toBe(2 * 3 + 20 * 0.05);
      expect(c.lineas[0].planName).toBe('Tarifa de integrador');
    });

    it('una tarifa mal formada se ignora y se usan los planes', () => {
      expect(calcularCobro(n(2), { tramos: 'x' }).tarifa).toBe('planes');
      expect(parseIntegratorPricing({ tramos: [] })).toBeNull();
      expect(parseIntegratorPricing(null)).toBeNull();
    });

    it('los tramos se ordenan aunque vengan desordenados', () => {
      const p = parseIntegratorPricing({
        tramos: [
          { hasta: null, precio: 2 },
          { hasta: 20, precio: 3 },
          { hasta: 50, precio: 2.5 },
        ],
        porDocumento: 0.05,
      })!;
      expect([1, 20, 21, 50, 51].map((k) => precioDelTramo(p, k))).toEqual([
        3, 3, 2.5, 2.5, 2,
      ]);
    });
  });
});
