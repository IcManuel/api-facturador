import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan } from 'typeorm';
import { Document } from '../../entities/document.entity';
import { DocumentError } from '../../entities/document-error.entity';
import { DocStatus, SriErrorCategory } from '../../entities/enums';
import { SriService } from '../sri/sri.service';
import { DocumentProcessingService } from './document-processing.service';
import { DocumentStatusNotifier } from './document-status-notifier';
import { EventsGateway } from '../../events/events.gateway';
import { RedisLockService } from '../../common/services/redis-lock.service';
import { NotificationService } from '../../notifications/notification.service';

/**
 * Cron job that cleans up documents stuck in non-terminal states.
 *
 * Terminal states: AUTHORIZED, REJECTED, FAILED
 * Non-terminal states that can get stuck: PROCESSING, RECEIVED, CREATED
 *
 * Runs every 5 minutes.
 */
@Injectable()
export class StaleDocumentCron {
  private readonly logger = new Logger(StaleDocumentCron.name);

  /** Documents stuck in PROCESSING for longer than this are considered crashed */
  private readonly PROCESSING_TIMEOUT_MIN = 10;
  /** Documents stuck in RECEIVED for longer than this get a final auth check */
  private readonly RECEIVED_TIMEOUT_MIN = 30;
  /** Documents stuck in CREATED for longer than this are marked FAILED */
  private readonly CREATED_TIMEOUT_MIN = 60;

  /** A system-retry whose scheduled time passed by more than this is considered "lost" */
  private readonly RETRY_GRACE_MIN = 10;
  /** SRI-incident threshold: this many docs with system errors within the window triggers an alert */
  private readonly INCIDENT_THRESHOLD = 8;
  private readonly INCIDENT_WINDOW_MIN = 60;

  constructor(
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(DocumentError)
    private readonly errorRepo: Repository<DocumentError>,
    private readonly sriService: SriService,
    private readonly processingService: DocumentProcessingService,
    private readonly eventsGateway: EventsGateway,
    private readonly redisLock: RedisLockService,
    private readonly notificationService: NotificationService,
    private readonly statusNotifier: DocumentStatusNotifier,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleStaleDocuments(): Promise<void> {
    // Distributed lock: only one instance runs the cron
    const acquired = await this.redisLock.acquire('stale-documents-cron', 240);
    if (!acquired) {
      this.logger.debug('Stale documents cron skipped — another instance holds the lock');
      return;
    }

    try {
      await Promise.all([
        this.recoverStuckProcessing(),
        this.resolveStuckReceived(),
        this.cleanupStuckCreated(),
        this.rescueLostSystemRetries(),
        this.detectSriIncident(),
      ]);
    } finally {
      await this.redisLock.release('stale-documents-cron');
    }
  }

  /**
   * Safety net for Layer 2: documents in FAILED with a pending system-retry
   * marker whose scheduled time passed long ago — their BullMQ job was lost
   * (server restart, Redis flush, etc.). Re-run the pipeline directly.
   */
  private async rescueLostSystemRetries(): Promise<void> {
    const graceCutoff = new Date(Date.now() - this.RETRY_GRACE_MIN * 60_000).toISOString();

    const stuck = await this.docRepo
      .createQueryBuilder('doc')
      .leftJoinAndSelect('doc.company', 'company')
      .where('doc.status = :status', { status: DocStatus.FAILED })
      .andWhere(`doc.payload -> '_systemRetry' IS NOT NULL`)
      .andWhere(`(doc.payload -> '_systemRetry' ->> 'nextAt') < :grace`, { grace: graceCutoff })
      .limit(20)
      .getMany();

    if (stuck.length === 0) return;
    this.logger.warn(`Found ${stuck.length} documents with a lost system-retry job — rescuing`);

    const todayStr = new Date().toISOString().slice(0, 10);

    for (const doc of stuck) {
      const sysRetry = (doc.payload as any)?._systemRetry ?? {};
      const issueStr =
        typeof doc.issueDate === 'string'
          ? (doc.issueDate as string).slice(0, 10)
          : new Date(doc.issueDate).toISOString().slice(0, 10);

      // Stale-dated documents can no longer be authorized — drop the marker.
      if (issueStr !== todayStr) {
        this.logger.warn(`Document ${doc.id}: issue date ${issueStr} is not today — clearing retry marker`);
        await this.clearRetryMarker(doc);
        continue;
      }

      try {
        const result = await this.processingService.processDocument(doc.id);
        if (result.status === 'failed') {
          const attempts = (sysRetry.attempts ?? 0) + 1;
          const max = sysRetry.max ?? 5;
          if (attempts >= max) {
            this.logger.warn(`Document ${doc.id}: ${attempts}/${max} system retries exhausted — leaving FAILED`);
            await this.clearRetryMarker(doc);
          } else {
            const payload = { ...(doc.payload as any) };
            payload._systemRetry = {
              nextAt: new Date(Date.now() + 30 * 60_000).toISOString(),
              attempts,
              max,
            };
            await this.docRepo.update(doc.id, { payload });
            this.logger.log(`Document ${doc.id}: cron retry ${attempts}/${max} failed — next in 30min`);
          }
        } else {
          await this.clearRetryMarker(doc);
          this.logger.log(`Document ${doc.id}: rescued by cron — status ${result.status}`);
        }
      } catch (err: any) {
        this.logger.error(`Document ${doc.id}: cron rescue crashed: ${err.message}`);
      }
    }
  }

  private async clearRetryMarker(doc: Document): Promise<void> {
    if (!(doc.payload as any)?._systemRetry) return;
    const payload = { ...(doc.payload as any) };
    delete payload._systemRetry;
    await this.docRepo.update(doc.id, { payload });
  }

  /**
   * Detect a possible SRI-wide incident: many documents hitting system errors
   * within a short window. Sends a single throttled email (once per hour).
   */
  private async detectSriIncident(): Promise<void> {
    const since = new Date(Date.now() - this.INCIDENT_WINDOW_MIN * 60_000);

    const recentSystemErrors = await this.errorRepo.find({
      where: { category: SriErrorCategory.SYSTEM, createdAt: MoreThan(since) },
      order: { createdAt: 'DESC' },
      take: 200,
    });

    const affectedDocs = new Set(recentSystemErrors.map((e) => e.documentId));
    if (affectedDocs.size < this.INCIDENT_THRESHOLD) return;

    // Throttle: only one incident email per hour. acquire() with no release
    // leaves the key to expire on its own.
    const canAlert = await this.redisLock.acquire('sri-incident-alert', 3600);
    if (!canAlert) {
      this.logger.warn(`SRI incident ongoing (${affectedDocs.size} docs) — alert already sent this hour`);
      return;
    }

    this.logger.error(`Possible SRI incident: ${affectedDocs.size} documents with system errors in ${this.INCIDENT_WINDOW_MIN}min`);

    const sampleMessages = Array.from(new Set(recentSystemErrors.map((e) => e.message))).slice(0, 5);
    await this.notificationService
      .sendSriIncidentAlert({
        systemErrorDocs: affectedDocs.size,
        windowMinutes: this.INCIDENT_WINDOW_MIN,
        sampleMessages,
      })
      .catch((err) => this.logger.error(`Failed to send SRI incident alert: ${err.message}`));
  }

  /**
   * Documents stuck in PROCESSING: the process crashed or timed out.
   * Reset to FAILED so they can be retried by the worker or manually.
   */
  private async recoverStuckProcessing(): Promise<void> {
    const cutoff = new Date(Date.now() - this.PROCESSING_TIMEOUT_MIN * 60_000);

    const stuck = await this.docRepo.find({
      where: {
        status: DocStatus.PROCESSING,
        updatedAt: LessThan(cutoff),
      },
      relations: ['company'],
    });

    if (stuck.length === 0) return;

    this.logger.warn(`Found ${stuck.length} documents stuck in PROCESSING (>${this.PROCESSING_TIMEOUT_MIN}min)`);

    for (const doc of stuck) {
      const stuckMinutes = Math.round((Date.now() - doc.updatedAt.getTime()) / 60_000);
      this.logger.warn(`Document ${doc.id}: stuck in PROCESSING for ${stuckMinutes}min — marking FAILED`);
      await this.docRepo.update(doc.id, {
        status: DocStatus.FAILED,
        retries: doc.retries + 1,
      });
      this.emitStatus(doc, 'FAILED');
    }
  }

  /**
   * Documents stuck in RECEIVED: SRI accepted but never authorized.
   * Try one final auth check. If authorized → update. Otherwise → FAILED.
   */
  private async resolveStuckReceived(): Promise<void> {
    const cutoff = new Date(Date.now() - this.RECEIVED_TIMEOUT_MIN * 60_000);

    const stuck = await this.docRepo.find({
      where: {
        status: DocStatus.RECEIVED,
        updatedAt: LessThan(cutoff),
      },
      relations: ['company'],
    });

    if (stuck.length === 0) return;

    this.logger.warn(`Found ${stuck.length} documents stuck in RECEIVED (>${this.RECEIVED_TIMEOUT_MIN}min)`);

    for (const doc of stuck) {
      const stuckMinutes = Math.round((Date.now() - doc.updatedAt.getTime()) / 60_000);
      this.logger.log(`Document ${doc.id}: stuck in RECEIVED for ${stuckMinutes}min — final auth check`);

      try {
        const authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
        this.logger.log(`Document ${doc.id}: final auth check → state=${authResult.state}, authorized=${authResult.authorized}`);

        if (authResult.authorized) {
          await this.docRepo.update(doc.id, {
            status: DocStatus.AUTHORIZED,
            authNumber: authResult.authorizationNumber ?? undefined,
            authAt: authResult.authorizedAt ? new Date(authResult.authorizedAt) : new Date(),
            billable: true,
          });
          this.logger.log(`Document ${doc.id}: recovered — AUTHORIZED by cron`);
          this.emitStatus(doc, 'AUTHORIZED');
        } else if (authResult.state === 'NO AUTORIZADO') {
          await this.docRepo.update(doc.id, {
            status: DocStatus.REJECTED,
            retries: doc.retries + 1,
          });
          this.logger.warn(`Document ${doc.id}: NO AUTORIZADO — marked REJECTED by cron`);
          this.emitStatus(doc, 'REJECTED');
        } else {
          // Still unknown/processing after 30+ min — give up
          await this.docRepo.update(doc.id, {
            status: DocStatus.FAILED,
            retries: doc.retries + 1,
          });
          this.logger.warn(`Document ${doc.id}: still ${authResult.state} after ${stuckMinutes}min — marked FAILED by cron`);
          this.emitStatus(doc, 'FAILED');
        }
      } catch (err: any) {
        this.logger.error(`Document ${doc.id}: final auth check failed: ${err.message}`);
        // Don't mark FAILED on network error — will retry next cron run
      }
    }
  }

  /**
   * Documents stuck in CREATED: never even started processing.
   * This shouldn't happen normally, but can if the queue job was lost.
   */
  private async cleanupStuckCreated(): Promise<void> {
    const cutoff = new Date(Date.now() - this.CREATED_TIMEOUT_MIN * 60_000);

    const stuck = await this.docRepo.find({
      where: {
        status: DocStatus.CREATED,
        updatedAt: LessThan(cutoff),
      },
      relations: ['company'],
    });

    if (stuck.length === 0) return;

    this.logger.warn(`Found ${stuck.length} documents stuck in CREATED (>${this.CREATED_TIMEOUT_MIN}min)`);

    for (const doc of stuck) {
      this.logger.warn(`Document ${doc.id}: stuck in CREATED — marking FAILED`);
      await this.docRepo.update(doc.id, {
        status: DocStatus.FAILED,
        retries: doc.retries + 1,
      });
      this.emitStatus(doc, 'FAILED');
    }
  }

  private emitStatus(doc: Document, status: string) {
    // Cada cambio de estado del cron sale también como webhook.
    void this.statusNotifier.notify(doc.id, status as DocStatus);
    try {
      this.eventsGateway.emitDocumentUpdate({
        documentId: doc.id,
        status,
        companyId: doc.companyId,
        accountId: doc.company?.accountId,
        accessKey: doc.accessKey,
        typeCode: doc.typeCode,
        sequential: doc.sequential,
      });
    } catch { /* non-critical */ }
  }
}
