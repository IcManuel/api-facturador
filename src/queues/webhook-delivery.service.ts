import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import axios from 'axios';
import { createHmac } from 'crypto';
import { Document } from '../entities/document.entity';
import { Company } from '../entities/company.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';
import { DocStatus } from '../entities/enums';
import { WEBHOOK_QUEUE } from './queues.constants';
import { formatDateTz } from '../common/utils/date.util';
import { DocumentStatusNotifier } from '../engine/processing/document-status-notifier';

export type DocumentWebhookEvent =
  | 'document.received'
  | 'document.processing'
  | 'document.authorized'
  | 'document.rejected'
  | 'document.failed';

const EVENT_FOR_STATUS: Record<string, DocumentWebhookEvent> = {
  [DocStatus.RECEIVED]: 'document.received',
  [DocStatus.PROCESSING]: 'document.processing',
  [DocStatus.AUTHORIZED]: 'document.authorized',
  [DocStatus.REJECTED]: 'document.rejected',
  [DocStatus.FAILED]: 'document.failed',
};

interface WebhookJobData {
  documentId: number;
  companyId: number;
  eventType: DocumentWebhookEvent;
}

@Injectable()
export class WebhookDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @InjectRepository(Document) private readonly docRepo: Repository<Document>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(WebhookEvent) private readonly eventRepo: Repository<WebhookEvent>,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
    private readonly statusNotifier: DocumentStatusNotifier,
  ) {}

  onModuleInit() {
    this.statusNotifier.register((documentId, status) => this.enqueueForStatus(documentId, status));
  }

  /**
   * Enqueue a webhook for a document state transition. Safe to call from inside
   * the processing pipeline — never throws, never blocks.
   */
  async enqueueForStatus(documentId: number, status: DocStatus): Promise<void> {
    const eventType = EVENT_FOR_STATUS[status];
    if (!eventType) return;

    try {
      const doc = await this.docRepo.findOne({
        where: { id: documentId },
        select: ['id', 'companyId'],
      });
      if (!doc) return;

      const company = await this.companyRepo.findOne({
        where: { id: doc.companyId },
        select: ['id', 'webhookUrl'],
      });
      if (!company?.webhookUrl) return;

      await this.queue.add(
        'deliver',
        { documentId: doc.id, companyId: company.id, eventType } as WebhookJobData,
        {
          jobId: `webhook-${doc.id}-${eventType}-${Date.now()}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 500,
          removeOnFail: 1000,
        },
      );
    } catch (err: any) {
      this.logger.error(`Failed to enqueue webhook for doc ${documentId}: ${err.message}`);
    }
  }

  /** Build the payload sent to the customer's webhook URL. */
  private async buildPayload(documentId: number, eventType: DocumentWebhookEvent) {
    const doc = await this.docRepo.findOne({
      where: { id: documentId },
      relations: ['company', 'errors'],
    });
    if (!doc) return null;
    const tz = doc.company?.timezone ?? 'America/Guayaquil';
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: {
        id: doc.id,
        claveAcceso: doc.accessKey,
        idempotencyKey: doc.idempotencyKey ?? null,
        estado: doc.status,
        tipoDocumento: doc.typeCode,
        secuencial: doc.sequential,
        ambiente: doc.env,
        fechaEmision: doc.issueDate,
        numeroAutorizacion: doc.authNumber ?? null,
        fechaAutorizacion: formatDateTz(doc.authAt, tz),
        errores: (doc.errors ?? []).map((e) => ({
          codigo: e.code,
          mensaje: e.message,
          detalle: e.detail,
          categoria: e.category,
        })),
        empresa: doc.company ? { ruc: doc.company.ruc, nombre: doc.company.name } : null,
      },
    };
  }

  /**
   * Deliver one webhook attempt. Called from the BullMQ worker. Throws on
   * failure (network or non-2xx) so BullMQ retries with backoff.
   */
  async deliver(job: WebhookJobData, attempt: number): Promise<void> {
    const payload = await this.buildPayload(job.documentId, job.eventType);
    if (!payload) return;

    const company = await this.companyRepo.findOne({
      where: { id: job.companyId },
      select: ['id', 'webhookUrl', 'webhookSecret'],
    });
    if (!company?.webhookUrl) return;

    const body = JSON.stringify(payload);
    const signature = company.webhookSecret
      ? 'sha256=' + createHmac('sha256', company.webhookSecret).update(body).digest('hex')
      : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'AutorizadorEC-Webhook/1.0',
      'X-AutorizadorEC-Event': job.eventType,
      'X-AutorizadorEC-Delivery': `${job.documentId}-${job.eventType}-${attempt}`,
    };
    if (signature) headers['X-AutorizadorEC-Signature'] = signature;

    const started = Date.now();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let success = false;
    let networkError: Error | null = null;

    try {
      const res = await axios.post(company.webhookUrl, body, {
        headers,
        timeout: 10_000,
        validateStatus: () => true,
        maxRedirects: 2,
      });
      statusCode = res.status;
      responseBody = typeof res.data === 'string' ? res.data.slice(0, 1000) : JSON.stringify(res.data).slice(0, 1000);
      success = res.status >= 200 && res.status < 300;
    } catch (err: any) {
      networkError = err;
      responseBody = err.message?.slice(0, 1000) ?? 'network error';
    }

    const durationMs = Date.now() - started;

    await this.eventRepo.save(
      this.eventRepo.create({
        documentId: job.documentId,
        companyId: job.companyId,
        eventType: job.eventType,
        url: company.webhookUrl,
        statusCode: statusCode ?? undefined,
        responseBody: responseBody ?? undefined,
        attempt,
        success,
        durationMs,
      }),
    );

    if (!success) {
      const msg = networkError
        ? `webhook network error: ${networkError.message}`
        : `webhook returned HTTP ${statusCode}`;
      throw new Error(msg);
    }
  }
}
