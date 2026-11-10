import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { conflictoPorDuplicado } from './documento-duplicado.util';

const violacion = (constraint: string, code = '23505') =>
  new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code, constraint }));

const doc = {
  companyId: 7,
  env: 'production',
  typeCode: '01',
  sequential: '001-001-000000009',
  idempotencyKey: 'K-1',
  contentHash: 'abc',
  accessKey: '123',
} as never;

const existente = { id: 55, companyId: 7, sequential: '001-001-000000009', accessKey: '123', status: 'AUTHORIZED' };

describe('conflictoPorDuplicado', () => {
  it('idempotencyKey simultáneo: 409 con el documento ya creado, buscado por empresa y ambiente', async () => {
    const findOne = jest.fn().mockResolvedValue(existente);
    const r = await conflictoPorDuplicado(violacion('uq_document_idempotency'), { findOne } as never, doc);
    expect(r).toBeInstanceOf(ConflictException);
    expect(findOne).toHaveBeenCalledWith({ where: { companyId: 7, env: 'production', idempotencyKey: 'K-1' } });
    expect(r!.getResponse()).toMatchObject({ documentoExistente: { id: 55, estado: 'AUTHORIZED' } });
  });

  it('secuencial repetido en la base (envío XML): 409 y no 500', async () => {
    const findOne = jest.fn().mockResolvedValue(existente);
    const r = await conflictoPorDuplicado(violacion('uq_document_sequential'), { findOne } as never, doc);
    expect(r).toBeInstanceOf(ConflictException);
  });

  it('una clave de acceso de otra empresa no se revela', async () => {
    const findOne = jest.fn().mockResolvedValue({ ...existente, companyId: 99 });
    const r = await conflictoPorDuplicado(violacion('uq_document_access_key'), { findOne } as never, doc);
    expect(r!.getResponse()).not.toHaveProperty('documentoExistente');
  });

  it('otros errores de base siguen su curso', async () => {
    const findOne = jest.fn();
    expect(await conflictoPorDuplicado(violacion('otra_regla'), { findOne } as never, doc)).toBeNull();
    expect(await conflictoPorDuplicado(violacion('x', '23503'), { findOne } as never, doc)).toBeNull();
    expect(await conflictoPorDuplicado(new Error('red'), { findOne } as never, doc)).toBeNull();
  });
});
