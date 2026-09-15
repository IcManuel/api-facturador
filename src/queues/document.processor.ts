import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, Queue } from 'bullmq';
import { DocumentProcessingService } from '../engine/processing/document-processing.service';
import { Document } from '../entities/document.entity';
import { DocStatus } from '../entities/enums';
import { DOCUMENT_QUEUE } from './queues.constants';
import { WebhookDeliveryService } from './webhook-delivery.service';

export interface ProcessDocumentJob {
  documentId: number;
  /** When true, only retry the authorization check (skip XML/sign/send) */
  authCheckOnly?: boolean;
}

/** Max number of auth-check retries before giving up */
const MAX_AUTH_CHECK_RETRIES = 10;
/** Delays for auth-check retries (in ms): 30s, 30s, 60s, 60s, 120s, 120s, 300s... */
const AUTH_CHECK_DELAYS = [30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 300_000, 300_000, 300_000, 300_000];

/** Max automatic retries for system/network failures before giving up */
const MAX_SYSTEM_RETRIES = 5;
/** Delays between system-error retries: 5min, 15min, 45min, 2h, 6h */
const SYSTEM_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

/**
 * Patrones de mensaje que indican un error NO transitorio (bug nuestro, error
 * de datos, código programático). Reintentar no va a arreglarlos — siempre
 * van a fallar igual. Se marcan FAILED definitivos para que un humano los
 * vea y los corrija.
 */
const NON_RETRYABLE_PATTERNS = [
  /value too long for type/i,
  /duplicate key value violates/i,
  /violates (not-null|check|foreign key)/i,
  /relation .* does not exist/i,
  /column .* does not exist/i,
  /invalid input syntax for/i,
  /syntax error/i,
  /TypeError:/,
  /ReferenceError:/,
  /Cannot read prop/i,
];

function isNonRetryableError(message: string): boolean {
  return NON_RETRYABLE_PATTERNS.some((rx) => rx.test(message));
}

@Processor(DOCUMENT_QUEUE, { concurrency: 5 })
export class DocumentProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    private readonly processingService: DocumentProcessingService,
    @InjectQueue(DOCUMENT_QUEUE) private readonly queue: Queue,
    @InjectRepository(Document) private readonly docRepo: Repository<Document>,
    private readonly config: ConfigService,
    private readonly webhookDelivery: WebhookDeliveryService,
  ) {
    super();
  }

  /** Best-effort: enqueue a webhook for the document's current status. */
  private async fireWebhook(documentId: number, status: DocStatus): Promise<void> {
    try {
      await this.webhookDelivery.enqueueForStatus(documentId, status);
    } catch (err: any) {
      this.logger.warn(`Failed to enqueue webhook for doc ${documentId}: ${err.message}`);
    }
  }

  onModuleInit() {
    const concurrency = Number(this.config.get('BULLMQ_CONCURRENCY', 5)) || 5;
    this.worker.concurrency = concurrency;
    this.logger.log(`Worker concurrency set to ${concurrency}`);
  }

  async process(job: Job<ProcessDocumentJob>): Promise<void> {
    const { documentId, authCheckOnly } = job.data;

    if (authCheckOnly) {
      return this.processAuthCheck(job);
    }

    this.logger.log(`Processing document ${documentId} (attempt ${job.attemptsMade + 1})`);

    const result = await this.processingService.processDocument(documentId);

    if (result.status === 'failed') {
      // System/network failure: schedule a delayed automatic retry instead of
      // leaving the document dead. Business errors are not auto-retried.
      await this.maybeScheduleSystemRetry(documentId, result);
      return;
    }

    // Reached a terminal/processing state — clear any pending retry marker.
    await this.clearSystemRetry(documentId);

    if (result.status === 'processing') {
      // SRI accepted but hasn't authorized yet — schedule delayed auth check
      await this.scheduleAuthCheck(documentId, 0);
      return;
    }

    // Los webhooks de este resultado ya los envía processDocument() a través de
    // DocumentStatusNotifier; enviarlos también aquí los duplicaría.

    this.logger.log(`Document ${documentId} finished: ${result.status} in ${result.processingTimeMs}ms`);
  }

  /**
   * After a system/network failure, schedule a delayed automatic retry of the
   * full pipeline. Capped at MAX_SYSTEM_RETRIES and only while the document's
   * issue date is still today (the SRI rejects stale-dated documents).
   */
  private async maybeScheduleSystemRetry(
    documentId: number,
    result: { errors: { code: string; message: string }[] },
  ): Promise<void> {
    const isSystemError = result.errors.some((e) => e.code === 'SYS001');
    if (!isSystemError) {
      // Business error (bad XML, SRI validation, expired cert) — no auto-retry.
      await this.clearSystemRetry(documentId);
      return;
    }

    // Even within SYS001, some errors are clearly non-transient (DB constraint
    // violations, programming bugs). Reintentar no los va a arreglar — los
    // dejamos FAILED definitivos para que un humano los revise.
    const isHardError = result.errors.some((e) => e.code === 'SYS001' && isNonRetryableError(e.message));
    if (isHardError) {
      this.logger.error(
        `Document ${documentId}: error no transitorio — no reintenta. Mensaje: ${result.errors.find((e) => isNonRetryableError(e.message))?.message}`,
      );
      await this.clearSystemRetry(documentId);
      return;
    }

    const doc = await this.docRepo.findOne({ where: { id: documentId } });
    if (!doc) return;

    const sysRetry = (doc.payload as any)?._systemRetry ?? { attempts: 0 };
    const nextAttempt = (sysRetry.attempts ?? 0) + 1;

    if (nextAttempt > MAX_SYSTEM_RETRIES) {
      this.logger.warn(`Document ${documentId}: max system retries (${MAX_SYSTEM_RETRIES}) reached — leaving FAILED`);
      await this.clearSystemRetry(documentId);
      return;
    }

    // The SRI rejects documents whose emission date is not "today" — once the
    // date rolls over, auto-retry is pointless and a manual reissue is needed.
    const todayStr = new Date().toISOString().slice(0, 10);
    const issueStr =
      typeof doc.issueDate === 'string'
        ? (doc.issueDate as string).slice(0, 10)
        : new Date(doc.issueDate).toISOString().slice(0, 10);
    if (issueStr !== todayStr) {
      this.logger.warn(
        `Document ${documentId}: issue date ${issueStr} is not today (${todayStr}) — no auto-retry, manual reissue required`,
      );
      await this.clearSystemRetry(documentId);
      return;
    }

    const delay = SYSTEM_RETRY_DELAYS_MS[nextAttempt - 1] ?? SYSTEM_RETRY_DELAYS_MS[SYSTEM_RETRY_DELAYS_MS.length - 1];
    const nextAt = new Date(Date.now() + delay);

    const newPayload = { ...(doc.payload as any) };
    newPayload._systemRetry = {
      nextAt: nextAt.toISOString(),
      attempts: nextAttempt,
      max: MAX_SYSTEM_RETRIES,
    };
    await this.docRepo.update(documentId, { payload: newPayload });

    await this.queue.add(
      'process',
      { documentId },
      { jobId: `doc-sysretry-${documentId}-${nextAttempt}`, delay, attempts: 1 },
    );

    this.logger.log(
      `Document ${documentId}: scheduled system retry ${nextAttempt}/${MAX_SYSTEM_RETRIES} in ${delay / 1000}s`,
    );
  }

  private async clearSystemRetry(documentId: number): Promise<void> {
    const doc = await this.docRepo.findOne({ where: { id: documentId } });
    if (!doc || !(doc.payload as any)?._systemRetry) return;
    const newPayload = { ...(doc.payload as any) };
    delete newPayload._systemRetry;
    await this.docRepo.update(documentId, { payload: newPayload });
  }

  /**
   * Process an auth-check-only job (for documents already sent to SRI).
   */
  private async processAuthCheck(job: Job<ProcessDocumentJob>): Promise<void> {
    const { documentId } = job.data;
    const attempt = job.attemptsMade;

    this.logger.log(`Auth check for document ${documentId} (attempt ${attempt + 1}/${MAX_AUTH_CHECK_RETRIES})`);

    const result = await this.processingService.retryAuthorization(documentId);

    if (result.status === 'processing' && attempt < MAX_AUTH_CHECK_RETRIES - 1) {
      await this.scheduleAuthCheck(documentId, attempt + 1);
      return;
    }

    if (result.status === 'processing') {
      this.logger.warn(`Document ${documentId}: SRI still processing after ${MAX_AUTH_CHECK_RETRIES} auth checks — marking FAILED`);
      await this.docRepo.update(documentId, { status: DocStatus.FAILED });
      await this.fireWebhook(documentId, DocStatus.FAILED);
      return;
    }

    // El aviso de authorized/rejected/failed ya lo da retryAuthorization().

    this.logger.log(`Auth check for document ${documentId}: ${result.status}`);
  }

  private async scheduleAuthCheck(documentId: number, attempt: number): Promise<void> {
    const delay = AUTH_CHECK_DELAYS[attempt] ?? 300_000;
    this.logger.log(`Scheduling auth check for document ${documentId} in ${delay / 1000}s (attempt ${attempt + 1})`);

    await this.queue.add('auth-check', {
      documentId,
      authCheckOnly: true,
    }, {
      jobId: `auth-check-${documentId}-${attempt}`,
      delay,
      attempts: 1, // Don't let BullMQ auto-retry auth checks — we manage retries ourselves
    });
  }
}
