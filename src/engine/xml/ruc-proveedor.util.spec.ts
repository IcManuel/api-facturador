describe('ruc-proveedor.util', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SRI_RUC_PROVEEDOR_SISTEMA: '0706410164001',
      SRI_RUC_PROVEEDOR_CAMPO_NOMBRE: 'RUC Proveedor',
      INCLUDE_RUC_PROVEEDOR: 'true',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('prepends the RUC proveedor campo when infoAdicional is empty', () => {
    const { withRucProveedor } = require('./ruc-proveedor.util');
    const result = withRucProveedor(undefined);
    expect(result).toEqual([{ nombre: 'RUC Proveedor', valor: '0706410164001' }]);
  });

  it('prepends the RUC proveedor campo keeping the client campos', () => {
    const { withRucProveedor } = require('./ruc-proveedor.util');
    const result = withRucProveedor([{ nombre: 'email', valor: 'a@a.com' }]);
    expect(result).toEqual([
      { nombre: 'RUC Proveedor', valor: '0706410164001' },
      { nombre: 'email', valor: 'a@a.com' },
    ]);
  });

  it('does not duplicate if the client already sent the same campo name', () => {
    const { withRucProveedor } = require('./ruc-proveedor.util');
    const result = withRucProveedor([{ nombre: 'RUC Proveedor', valor: 'algo-distinto' }]);
    expect(result).toEqual([{ nombre: 'RUC Proveedor', valor: '0706410164001' }]);
  });

  it('caps at 15 campos, dropping the client\'s last one', () => {
    const { withRucProveedor } = require('./ruc-proveedor.util');
    const clientCampos = Array.from({ length: 15 }, (_, i) => ({ nombre: `campo${i}`, valor: String(i) }));
    const result = withRucProveedor(clientCampos);
    expect(result).toHaveLength(15);
    expect(result[0]).toEqual({ nombre: 'RUC Proveedor', valor: '0706410164001' });
    expect(result.find((c: any) => c.nombre === 'campo14')).toBeUndefined();
  });

  it('is a no-op when INCLUDE_RUC_PROVEEDOR=false', () => {
    process.env.INCLUDE_RUC_PROVEEDOR = 'false';
    const { withRucProveedor } = require('./ruc-proveedor.util');
    const result = withRucProveedor([{ nombre: 'email', valor: 'a@a.com' }]);
    expect(result).toEqual([{ nombre: 'email', valor: 'a@a.com' }]);
  });

  it('injects into a raw XML that has no infoAdicional block', () => {
    const { injectRucProveedorIntoRawXml } = require('./ruc-proveedor.util');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="2.1.0"><detalles><detalle><codigoPrincipal>A</codigoPrincipal></detalle></detalles></factura>';
    const result = injectRucProveedorIntoRawXml(xml);
    expect(result).toContain('<infoAdicional>');
    expect(result).toContain('<campoAdicional nombre="RUC Proveedor">0706410164001</campoAdicional>');
  });

  it('injects into a raw XML that already has infoAdicional with other campos', () => {
    const { injectRucProveedorIntoRawXml } = require('./ruc-proveedor.util');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="2.1.0"><infoAdicional><campoAdicional nombre="email">a@a.com</campoAdicional></infoAdicional></factura>';
    const result = injectRucProveedorIntoRawXml(xml);
    expect(result).toContain('nombre="email"');
    expect(result).toContain('<campoAdicional nombre="RUC Proveedor">0706410164001</campoAdicional>');
  });

  it('does not duplicate when the raw XML already carries the same campo', () => {
    const { injectRucProveedorIntoRawXml } = require('./ruc-proveedor.util');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="2.1.0"><infoAdicional><campoAdicional nombre="RUC Proveedor">0706410164001</campoAdicional></infoAdicional></factura>';
    const result = injectRucProveedorIntoRawXml(xml);
    const matches = result.match(/RUC Proveedor/g) || [];
    expect(matches).toHaveLength(1);
  });
});
