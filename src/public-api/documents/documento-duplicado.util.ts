import { ConflictException } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import { Document } from '../../entities/document.entity';

/**
 * Dos solicitudes simultáneas pueden pasar las validaciones previas y chocar en los índices
 * únicos de la base. Esa carrera debe responder 409, igual que el duplicado normal, y no 500.
 * Devuelve la excepción a lanzar, o null si el error no es un duplicado conocido.
 */
export async function conflictoPorDuplicado(
  err: unknown,
  docRepo: Repository<Document>,
  doc: Document,
): Promise<ConflictException | null> {
  if (!(err instanceof QueryFailedError)) return null;
  const driver = err.driverError as { code?: string; constraint?: string };
  if (driver?.code !== '23505') return null;

  const base = { companyId: doc.companyId, env: doc.env };
  const casos: Record<string, { where: object; message: string }> = {
    uq_document_idempotency: {
      where: { ...base, idempotencyKey: doc.idempotencyKey },
      message: `Ya existe un documento con idempotencyKey "${doc.idempotencyKey}".`,
    },
    uq_document_sequential: {
      where: { ...base, typeCode: doc.typeCode, sequential: doc.sequential },
      message: `El secuencial ${doc.sequential} ya fue usado para este tipo de documento.`,
    },
    uq_document_content_hash: {
      where: { ...base, contentHash: doc.contentHash },
      message: 'Documento duplicado detectado. Ya existe un documento con el mismo contenido.',
    },
    uq_document_access_key: {
      where: { accessKey: doc.accessKey },
      message: 'Ya existe un documento con esta clave de acceso.',
    },
  };
  const caso = casos[driver.constraint ?? ''];
  if (!caso) return null;

  const existente = await docRepo.findOne({ where: caso.where });
  return new ConflictException({
    message: caso.message,
    // Una clave de acceso repetida puede ser de otra empresa: solo se muestra el propio
    ...(existente && existente.companyId === doc.companyId
      ? {
          documentoExistente: {
            id: existente.id,
            secuencial: existente.sequential,
            claveAcceso: existente.accessKey,
            estado: existente.status,
          },
        }
      : {}),
  });
}
