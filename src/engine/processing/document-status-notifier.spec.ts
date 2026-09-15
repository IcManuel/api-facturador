import { Logger } from '@nestjs/common';
import { DocumentStatusNotifier } from './document-status-notifier';
import { DocumentProcessingService } from './document-processing.service';
import { DocStatus } from '../../entities/enums';

describe('DocumentStatusNotifier', () => {
  it('sin nadie registrado no hace nada', async () => {
    await expect(new DocumentStatusNotifier().notify(1, DocStatus.AUTHORIZED)).resolves.toBeUndefined();
  });

  it('entrega el aviso al registrado', async () => {
    const n = new DocumentStatusNotifier();
    const recibido: any[] = [];
    n.register(async (id, st) => { recibido.push([id, st]); });
    await n.notify(11638, DocStatus.AUTHORIZED);
    expect(recibido).toEqual([[11638, DocStatus.AUTHORIZED]]);
  });

  it('si el aviso falla no rompe el procesamiento', async () => {
    const n = new DocumentStatusNotifier();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    n.register(async () => { throw new Error('redis caído'); });
    await expect(n.notify(1, DocStatus.FAILED)).resolves.toBeUndefined();
  });
});

describe('DocumentProcessingService avisa en todos los caminos', () => {
  function montar(resultado: string) {
    const avisos: any[] = [];
    const svc = Object.create(DocumentProcessingService.prototype) as any;
    svc.statusNotifier = { notify: async (id: number, st: DocStatus) => { avisos.push([id, st]); } };
    svc.runPipeline = async () => ({ status: resultado, errors: [], processingTimeMs: 1 });
    svc.runAuthorizationCheck = async () => ({ status: resultado, errors: [], processingTimeMs: 1 });
    return { svc, avisos };
  }

  it.each([
    ['authorized', DocStatus.AUTHORIZED],
    ['rejected', DocStatus.REJECTED],
    ['failed', DocStatus.FAILED],
    ['processing', DocStatus.RECEIVED],
  ])('processDocument %s → avisa %s', async (res, estado) => {
    const { svc, avisos } = montar(res);
    await svc.processDocument(7);
    expect(avisos).toEqual([[7, estado]]);
  });

  it.each([
    ['authorized', DocStatus.AUTHORIZED],
    ['rejected', DocStatus.REJECTED],
    ['failed', DocStatus.FAILED],
  ])('retryAuthorization %s → avisa %s', async (res, estado) => {
    const { svc, avisos } = montar(res);
    await svc.retryAuthorization(7);
    expect(avisos).toEqual([[7, estado]]);
  });

  it('retryAuthorization que sigue processing no repite aviso', async () => {
    const { svc, avisos } = montar('processing');
    await svc.retryAuthorization(7);
    expect(avisos).toEqual([]);
  });
});
