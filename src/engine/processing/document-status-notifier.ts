import { Injectable, Logger } from '@nestjs/common';
import { DocStatus } from '../../entities/enums';

export type StatusListener = (documentId: number, status: DocStatus) => Promise<void>;

/**
 * Punto único por donde pasa cada cambio de estado de un documento, para que
 * el webhook salga siempre, venga de donde venga el cambio.
 *
 * Antes solo avisaba el worker de la cola. Los caminos que procesan fuera de
 * ella —emitir/corregir en modo síncrono, el cron que rescata reintentos
 * perdidos, "reemitir hoy", retry-authorization— cambiaban el estado en
 * silencio. En septiembre de 2026 un integrador tenía 7 facturas AUTORIZADAS
 * en el SRI marcadas como fallidas: el cron las había reenviado con clave
 * nueva y nunca se enteró.
 *
 * Vive en EngineModule y el servicio de webhooks (QueuesModule, que importa
 * EngineModule) se registra aquí al arrancar. Así el motor puede avisar sin
 * depender de la cola, que crearía una dependencia circular.
 */
@Injectable()
export class DocumentStatusNotifier {
  private readonly logger = new Logger(DocumentStatusNotifier.name);
  private listener: StatusListener | null = null;

  register(listener: StatusListener): void {
    this.listener = listener;
  }

  /** Nunca lanza: un aviso que falla no puede tumbar el procesamiento. */
  async notify(documentId: number, status: DocStatus): Promise<void> {
    if (!this.listener) return;
    try {
      await this.listener(documentId, status);
    } catch (err: any) {
      this.logger.warn(`No se pudo notificar ${status} del documento ${documentId}: ${err.message}`);
    }
  }
}
