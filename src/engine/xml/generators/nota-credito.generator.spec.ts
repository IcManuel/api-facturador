import { NotaCreditoGenerator } from './nota-credito.generator';

describe('NotaCreditoGenerator', () => {
  const gen = new NotaCreditoGenerator();

  const baseData = {
    ambiente: '1',
    razonSocial: 'EMPRESA TEST S.A.',
    ruc: '0992191813001',
    claveAcceso: '0603202604099219181300110010010000000021234567813',
    establecimiento: '001',
    puntoEmision: '001',
    secuencial: '000000002',
    dirMatriz: 'Guayaquil, Ecuador',
    fechaEmision: '06/03/2026',
    tipoIdentificacionComprador: '04',
    razonSocialComprador: 'COMPRADOR TEST S.A.',
    identificacionComprador: '0706410164001',
    obligadoContabilidad: 'SI',
    codDocModificado: '01',
    numDocModificado: '001-001-000000001',
    fechaEmisionDocSustento: '05/03/2026',
    totalSinImpuestos: 50,
    valorModificacion: 57.50,
    totalConImpuestos: [
      { codigo: '2', codigoPorcentaje: '4', baseImponible: 50, valor: 7.50 },
    ],
    motivo: 'Devolucion de producto defectuoso',
    detalles: [
      {
        codigoInterno: 'PROD001',
        descripcion: 'Producto devuelto',
        cantidad: 1,
        precioUnitario: 50,
        descuento: 0,
        precioTotalSinImpuesto: 50,
        impuestos: [
          { codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 50, valor: 7.50 },
        ],
      },
    ],
  };

  it('should generate valid notaCredito XML', () => {
    const xml = gen.generate(baseData);
    expect(xml).toContain('<notaCredito');
    expect(xml).toContain('version="1.1.0"');
    expect(xml).toContain('<codDoc>04</codDoc>');
  });

  it('conserva los 6 decimales de cantidad y precioUnitario', () => {
    const xml = gen.generate({
      ...baseData,
      detalles: [{ ...baseData.detalles[0], cantidad: 2.5, precioUnitario: 1.234567 }],
    });
    expect(xml).toContain('<cantidad>2.500000</cantidad>');
    expect(xml).toContain('<precioUnitario>1.234567</precioUnitario>');
  });

  it('should start with XML declaration', () => {
    const xml = gen.generate(baseData);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  });

  it('should include infoTributaria', () => {
    const xml = gen.generate(baseData);
    expect(xml).toContain('<ambiente>1</ambiente>');
    expect(xml).toContain('<tipoEmision>1</tipoEmision>');
    expect(xml).toContain('<razonSocial>EMPRESA TEST S.A.</razonSocial>');
    expect(xml).toContain(`<ruc>${baseData.ruc}</ruc>`);
    expect(xml).toContain(`<claveAcceso>${baseData.claveAcceso}</claveAcceso>`);
    expect(xml).toContain('<estab>001</estab>');
    expect(xml).toContain('<ptoEmi>001</ptoEmi>');
    expect(xml).toContain('<secuencial>000000002</secuencial>');
    expect(xml).toContain('<dirMatriz>Guayaquil, Ecuador</dirMatriz>');
  });

  it('should include infoNotaCredito', () => {
    const xml = gen.generate(baseData);
    expect(xml).toContain('<infoNotaCredito>');
    expect(xml).toContain('<fechaEmision>06/03/2026</fechaEmision>');
    expect(xml).toContain('<tipoIdentificacionComprador>04</tipoIdentificacionComprador>');
    expect(xml).toContain('<razonSocialComprador>COMPRADOR TEST S.A.</razonSocialComprador>');
    expect(xml).toContain('<identificacionComprador>0706410164001</identificacionComprador>');
    expect(xml).toContain('<obligadoContabilidad>SI</obligadoContabilidad>');
    expect(xml).toContain('<codDocModificado>01</codDocModificado>');
    expect(xml).toContain('<numDocModificado>001-001-000000001</numDocModificado>');
    expect(xml).toContain('<fechaEmisionDocSustento>05/03/2026</fechaEmisionDocSustento>');
    expect(xml).toContain('<totalSinImpuestos>50.00</totalSinImpuestos>');
    expect(xml).toContain('<valorModificacion>57.50</valorModificacion>');
    expect(xml).toContain('<motivo>Devolucion de producto defectuoso</motivo>');
  });

  it('should include totalConImpuestos', () => {
    const xml = gen.generate(baseData);
    expect(xml).toContain('<totalConImpuestos>');
    expect(xml).toContain('<totalImpuesto>');
    expect(xml).toContain('<codigo>2</codigo>');
    expect(xml).toContain('<codigoPorcentaje>4</codigoPorcentaje>');
    expect(xml).toContain('<baseImponible>50.00</baseImponible>');
    expect(xml).toContain('<valor>7.50</valor>');
  });

  it('should include detalles', () => {
    const xml = gen.generate(baseData);
    expect(xml).toContain('<detalles>');
    expect(xml).toContain('<detalle>');
    expect(xml).toContain('<codigoInterno>PROD001</codigoInterno>');
    expect(xml).toContain('<descripcion>Producto devuelto</descripcion>');
    expect(xml).toContain('<cantidad>1.000000</cantidad>');
    expect(xml).toContain('<precioUnitario>50.000000</precioUnitario>');
    expect(xml).toContain('<descuento>0.00</descuento>');
    expect(xml).toContain('<precioTotalSinImpuesto>50.00</precioTotalSinImpuesto>');
    expect(xml).toContain('<tarifa>15.00</tarifa>');
  });

  it('should include optional dirEstablecimiento', () => {
    const xml = gen.generate({ ...baseData, dirEstablecimiento: 'Sucursal Sur' });
    expect(xml).toContain('<dirEstablecimiento>Sucursal Sur</dirEstablecimiento>');
  });

  it('should include optional contribuyenteEspecial', () => {
    const xml = gen.generate({ ...baseData, contribuyenteEspecial: '5678' });
    expect(xml).toContain('<contribuyenteEspecial>5678</contribuyenteEspecial>');
  });

  it('should include optional rise', () => {
    const xml = gen.generate({ ...baseData, rise: 'Contribuyente RISE' });
    expect(xml).toContain('<rise>Contribuyente RISE</rise>');
  });

  it('should include optional moneda', () => {
    const xml = gen.generate({ ...baseData, moneda: 'DOLAR' });
    expect(xml).toContain('<moneda>DOLAR</moneda>');
  });

  it('should omit moneda when not provided', () => {
    const xml = gen.generate(baseData);
    expect(xml).not.toContain('<moneda>');
  });

  it('should include nombreComercial when set', () => {
    const xml = gen.generate({ ...baseData, nombreComercial: 'MI TIENDA' });
    expect(xml).toContain('<nombreComercial>MI TIENDA</nombreComercial>');
  });

  it('should include contribuyenteRimpe when set', () => {
    const xml = gen.generate({ ...baseData, contribuyenteRimpe: 'CONTRIBUYENTE REGIMEN GENERAL' });
    expect(xml).toContain('<contribuyenteRimpe>CONTRIBUYENTE REGIMEN GENERAL</contribuyenteRimpe>');
  });

  it('should include regimenMicroempresas when set', () => {
    const xml = gen.generate({ ...baseData, regimenMicroempresas: true });
    expect(xml).toContain('<regimenMicroempresas>CONTRIBUYENTE RÉGIMEN MICROEMPRESAS</regimenMicroempresas>');
  });

  it('should include agenteRetencion when set', () => {
    const xml = gen.generate({ ...baseData, agenteRetencion: '1' });
    expect(xml).toContain('<agenteRetencion>1</agenteRetencion>');
  });

  it('should default obligadoContabilidad to NO', () => {
    const { obligadoContabilidad, ...rest } = baseData;
    const xml = gen.generate(rest as any);
    expect(xml).toContain('<obligadoContabilidad>NO</obligadoContabilidad>');
  });

  it('should include infoAdicional', () => {
    const xml = gen.generate({
      ...baseData,
      infoAdicional: [{ nombre: 'Email', valor: 'test@test.com' }],
    });
    expect(xml).toContain('<infoAdicional>');
    expect(xml).toContain('nombre="Email"');
    expect(xml).toContain('test@test.com');
  });

  it('should omit infoAdicional when not provided', () => {
    const xml = gen.generate(baseData);
    expect(xml).not.toContain('<infoAdicional>');
  });

  it('should include codigoAdicional when provided', () => {
    const data = {
      ...baseData,
      detalles: [{
        ...baseData.detalles[0],
        codigoAdicional: 'AUX001',
      }],
    };
    const xml = gen.generate(data);
    expect(xml).toContain('<codigoAdicional>AUX001</codigoAdicional>');
  });

  it('should include detallesAdicionales on line items', () => {
    const data = {
      ...baseData,
      detalles: [{
        ...baseData.detalles[0],
        detallesAdicionales: [{ nombre: 'Motivo', valor: 'Defecto de fabrica' }],
      }],
    };
    const xml = gen.generate(data);
    expect(xml).toContain('<detallesAdicionales>');
    expect(xml).toContain('nombre="Motivo"');
  });

  it('should handle multiple detalles', () => {
    const data = {
      ...baseData,
      detalles: [
        baseData.detalles[0],
        {
          descripcion: 'Segundo producto',
          cantidad: 2,
          precioUnitario: 25,
          precioTotalSinImpuesto: 50,
          impuestos: [
            { codigo: '2', codigoPorcentaje: '0', tarifa: 0, baseImponible: 50, valor: 0 },
          ],
        },
      ],
    };
    const xml = gen.generate(data);
    expect(xml).toContain('Producto devuelto');
    expect(xml).toContain('Segundo producto');
  });

  it('should omit descuento when null/undefined', () => {
    const data = {
      ...baseData,
      detalles: [{
        descripcion: 'Sin descuento',
        cantidad: 1,
        precioUnitario: 100,
        precioTotalSinImpuesto: 100,
        impuestos: [
          { codigo: '2', codigoPorcentaje: '0', tarifa: 0, baseImponible: 100, valor: 0 },
        ],
      }],
    };
    const xml = gen.generate(data);
    expect(xml).not.toContain('<descuento>');
  });
});
