import { classifySriMessages, SriErrorAction } from './sri-errors';

describe('classifySriMessages', () => {
  it('43 (clave registrada): el SRI ya tiene el comprobante → consultar autorización', () => {
    expect(classifySriMessages([{ identifier: '43' }])).toBe(SriErrorAction.SKIP_TO_AUTH);
  });

  it('45 (secuencial registrado): otro comprobante ya usó ese número → rechazar', () => {
    // Caso real: retención 003-003-000000001 de un emisor que ya había usado ese
    // número desde otro sistema. Tratarlo como "ya recibido" dejaba el documento
    // esperando una autorización que nunca iba a llegar.
    expect(classifySriMessages([{ identifier: '45' }])).toBe(SriErrorAction.REJECT);
  });

  it('70 (clave en procesamiento): reintentar la recepción', () => {
    expect(classifySriMessages([{ identifier: '70' }])).toBe(SriErrorAction.RETRY);
  });

  it('36 (clave devuelta): necesita clave nueva', () => {
    expect(classifySriMessages([{ identifier: '36' }])).toBe(SriErrorAction.NEED_NEW_KEY);
  });

  it('si en la misma respuesta vienen 43 y un error de datos, manda la consulta de autorización', () => {
    expect(classifySriMessages([{ identifier: '43' }, { identifier: '35' }])).not.toBe(SriErrorAction.REJECT);
  });

  it('un código desconocido se rechaza', () => {
    expect(classifySriMessages([{ identifier: '9999' }])).toBe(SriErrorAction.REJECT);
  });
});
