import { DocumentProcessingService } from './document-processing.service';
import { DocStatus } from '../../entities/enums';

const CLAVE_ACTUAL = '0310202601131040799200120010060000124862808661817';
const CLAVE_AUTORIZADA = '0310202601131040799200120010060000124860372241318';
const OTRA_CLAVE = '0310202601131040799200120010060000124868847483010';

function servicio(opts: {
  doc: any;
  autorizadas?: string[];
  sriCaido?: boolean;
}) {
  const svc = Object.create(DocumentProcessingService.prototype) as any;
  const updates: any[] = [];
  svc.logger = { warn: jest.fn(), log: jest.fn() };
  svc.docRepo = {
    findOne: jest.fn(async () => opts.doc),
    update: jest.fn(async (_id: number, patch: any) => { updates.push(patch); }),
  };
  svc.sriService = {
    checkAuthorization: jest.fn(async (key: string) => {
      if (opts.sriCaido) throw new Error('timeout');
      return { authorized: (opts.autorizadas ?? []).includes(key), state: 'X', messages: [] };
    }),
  };
  svc.addTimeline = jest.fn();
  svc.retryAuthorization = jest.fn(async () => ({ status: 'authorized' }));
  svc.runAuthorizationCheck = jest.fn(async () => ({ status: 'authorized' }));
  return { svc, updates };
}

describe('historial de claves de acceso', () => {
  it('agrega la clave anterior sin duplicar y conserva el resto del payload', () => {
    const p1 = DocumentProcessingService.payloadWithPreviousKey({ fechaEmision: '03/10/2026' }, CLAVE_AUTORIZADA);
    const p2 = DocumentProcessingService.payloadWithPreviousKey(p1, CLAVE_AUTORIZADA);
    const p3 = DocumentProcessingService.payloadWithPreviousKey(p2, OTRA_CLAVE);
    expect(p3.fechaEmision).toBe('03/10/2026');
    expect(p3._clavesAnteriores).toEqual([CLAVE_AUTORIZADA, OTRA_CLAVE]);
  });

  it('un documento sin historial devuelve una lista vacía', () => {
    expect(DocumentProcessingService.previousKeysOf({ payload: {} } as any)).toEqual([]);
    expect(DocumentProcessingService.previousKeysOf({ payload: null } as any)).toEqual([]);
  });
});

describe('syncIfAuthorizedAtSri', () => {
  const docFallido = () => ({
    id: 13383, env: 'production', status: DocStatus.FAILED, accessKey: CLAVE_ACTUAL,
    payload: { _clavesAnteriores: [OTRA_CLAVE, CLAVE_AUTORIZADA] },
  });

  it('caso real: la clave actual no está autorizada pero una anterior sí → usa la autorizada', async () => {
    const { svc, updates } = servicio({ doc: docFallido(), autorizadas: [CLAVE_AUTORIZADA] });
    await expect(svc.syncIfAuthorizedAtSri(13383)).resolves.toBe('authorized');
    expect(updates[0].accessKey).toBe(CLAVE_AUTORIZADA);
    expect(updates[0].status).toBe(DocStatus.RECEIVED);
    // la clave que se abandona queda en el historial
    expect(updates[0].payload._clavesAnteriores).toContain(CLAVE_ACTUAL);
    expect(svc.retryAuthorization).toHaveBeenCalledWith(13383);
  });

  it('ninguna clave autorizada → no toca el documento', async () => {
    const { svc, updates } = servicio({ doc: docFallido(), autorizadas: [] });
    await expect(svc.syncIfAuthorizedAtSri(13383)).resolves.toBe('not_authorized');
    expect(updates).toHaveLength(0);
    expect(svc.sriService.checkAuthorization).toHaveBeenCalledTimes(3);
  });

  it('si el SRI no responde, NO es seguro regenerar la clave', async () => {
    const { svc, updates } = servicio({ doc: docFallido(), sriCaido: true });
    await expect(svc.syncIfAuthorizedAtSri(13383)).resolves.toBe('unverifiable');
    expect(updates).toHaveLength(0);
  });

  it('dentro del procesamiento no avisa dos veces', async () => {
    const { svc } = servicio({ doc: docFallido(), autorizadas: [CLAVE_AUTORIZADA] });
    await svc.syncIfAuthorizedAtSri(13383, { notify: false });
    expect(svc.runAuthorizationCheck).toHaveBeenCalledWith(13383);
    expect(svc.retryAuthorization).not.toHaveBeenCalled();
  });
});
