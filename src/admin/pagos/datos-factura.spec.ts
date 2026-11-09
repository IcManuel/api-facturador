import { armarDatosFactura, ClienteFilaFactura } from './datos-factura';

const cuenta: ClienteFilaFactura = {
  accountName: 'MCMTech SAS',
  accountRuc: '0195130329001',
  accountEmail: 'hello@mcmtech.agency',
  accountPhone: '0998914517',
  accountAddress: null,
  companyName: null,
  companyTradeName: null,
  companyEmail: null,
  companyPhone: null,
  companyAddress: null,
};

describe('armarDatosFactura', () => {
  it('desglosa el IVA incluido del período pagado', () => {
    const r = armarDatosFactura(
      cuenta,
      [{ amount: 5, periodStart: '2026-10-06', periodEnd: '2026-11-05' }],
      5,
      null,
    );
    expect(r.lineas[0].concepto).toContain('período 06/10/2026 al 05/11/2026');
    expect(r).toMatchObject({ subtotal: 4.35, iva: 0.65, total: 5 });
  });

  it('factura al titular cuando ninguna empresa tiene su RUC', () => {
    const r = armarDatosFactura(cuenta, [], 5, null);
    expect(r.cliente).toMatchObject({
      razonSocial: 'MCMTech SAS',
      correo: 'hello@mcmtech.agency',
      direccion: null,
    });
  });

  it('prefiere la razón social y la dirección de la empresa del mismo RUC', () => {
    const r = armarDatosFactura(
      {
        ...cuenta,
        accountName: 'Opticas kler',
        companyName: 'PACHECO FABARA KLEVER ESMELIN',
        companyTradeName: 'Opticas Kler',
        companyAddress: 'Avenida Amazonas 8-56 y Calixto Pino',
      },
      [{ amount: 5, periodStart: '2026-11-03', periodEnd: '2026-12-02' }],
      5,
      'Bajo Demanda',
    );
    expect(r.cliente.razonSocial).toBe('PACHECO FABARA KLEVER ESMELIN');
    expect(r.cliente.direccion).toBe('Avenida Amazonas 8-56 y Calixto Pino');
    expect(r.lineas[0].concepto).toContain('plan Bajo Demanda (primer mes)');
  });

  it('con varios períodos subtotal + IVA suman el total exacto', () => {
    const r = armarDatosFactura(
      cuenta,
      [
        { amount: 5, periodStart: '2026-08-01', periodEnd: '2026-08-31' },
        { amount: 18.45, periodStart: '2026-09-01', periodEnd: '2026-09-30' },
      ],
      23.45,
      null,
    );
    expect(r.total).toBe(23.45);
    expect(Math.round((r.subtotal + r.iva) * 100)).toBe(2345);
  });
});
