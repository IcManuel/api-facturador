import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Document } from '../../entities/document.entity';
import { DocumentTimeline } from '../../entities/document-timeline.entity';
import { DocumentError } from '../../entities/document-error.entity';
import { DocumentFile } from '../../entities/document-file.entity';
import { Certificate } from '../../entities/certificate.entity';
import {
  DocStatus, TimelineStepStatus, SriErrorCategory, SriErrorSeverity, DocFileType, SriDocTypeCode,
} from '../../entities/enums';
import { XmlService } from '../xml/xml.service';
import { SigningService } from '../signing/signing.service';
import { SriService, SriAuthorizationResult } from '../sri/sri.service';
import { AccessKeyService } from '../sequential/access-key.service';
import { S3StorageService } from '../storage/s3.service';
import { RideService, RideData } from '../ride/ride.service';
import { CryptoService } from '../../common/services/crypto.service';
import { MailService } from '../../common/services/mail.service';
import { classifySriMessages, SriErrorAction } from '../sri/sri-errors';
import { EventsGateway } from '../../events/events.gateway';
import { NotificationService } from '../../notifications/notification.service';
import { withRucProveedor, injectRucProveedorIntoRawXml } from '../xml/ruc-proveedor.util';

export interface ProcessingResult {
  status: 'authorized' | 'rejected' | 'failed' | 'processing';
  authorizationNumber?: string;
  authorizedAt?: string;
  errors: { code: string; message: string; detail?: string }[];
  processingTimeMs: number;
}

@Injectable()
export class DocumentProcessingService {
  private readonly logger = new Logger(DocumentProcessingService.name);

  constructor(
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(DocumentTimeline)
    private readonly timelineRepo: Repository<DocumentTimeline>,
    @InjectRepository(DocumentError)
    private readonly errorRepo: Repository<DocumentError>,
    @InjectRepository(DocumentFile)
    private readonly fileRepo: Repository<DocumentFile>,
    @InjectRepository(Certificate)
    private readonly certRepo: Repository<Certificate>,
    private readonly xmlService: XmlService,
    private readonly signingService: SigningService,
    private readonly sriService: SriService,
    private readonly accessKeyService: AccessKeyService,
    private readonly s3Service: S3StorageService,
    private readonly rideService: RideService,
    private readonly cryptoService: CryptoService,
    private readonly mailService: MailService,
    private readonly eventsGateway: EventsGateway,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Full document processing pipeline: XML generation -> sign -> SRI send -> authorization.
   * Used by both the BullMQ worker (async) and the sync endpoint.
   */
  async processDocument(documentId: number): Promise<ProcessingResult> {
    const startTime = Date.now();
    const collectedErrors: ProcessingResult['errors'] = [];

    const doc = await this.docRepo.findOne({
      where: { id: documentId },
      relations: ['company', 'company.account'],
    });

    if (!doc) {
      throw new Error(`Document ${documentId} not found`);
    }

    // Guard: skip if already authorized
    if (doc.status === DocStatus.AUTHORIZED) {
      this.logger.warn(`Document ${documentId} is already AUTHORIZED — skipping`);
      return {
        status: 'authorized',
        authorizationNumber: doc.authNumber,
        authorizedAt: doc.authAt?.toISOString(),
        errors: [],
        processingTimeMs: 0,
      };
    }

    // Pre-processing validations
    const company = doc.company;
    if (!company) {
      throw new Error(`Company not found for document ${documentId}`);
    }
    if (company.status !== 'active') {
      throw new Error(`La empresa "${company.name}" está ${company.status}. No se puede procesar documentos.`);
    }

    // Mark as processing with optimistic lock.
    // Allows PROCESSING too — a previous attempt may have crashed/timed out leaving it stuck.
    // BullMQ already ensures no concurrent execution of the same job.
    const updateResult = await this.docRepo
      .createQueryBuilder()
      .update(Document)
      .set({ status: DocStatus.PROCESSING })
      .where('id = :id AND status IN (:...states)', {
        id: documentId,
        states: [DocStatus.CREATED, DocStatus.FAILED, DocStatus.REJECTED, DocStatus.PROCESSING, DocStatus.RECEIVED],
      })
      .execute();

    if (updateResult.affected === 0) {
      // Only AUTHORIZED would be blocked here
      const fresh = await this.docRepo.findOne({ where: { id: documentId } });
      this.logger.warn(`Document ${documentId} in state ${fresh?.status} — cannot reprocess`);
      return { status: 'processing', errors: [], processingTimeMs: 0 };
    }

    // If this is a retry (anything but a fresh CREATED), drop the previous
    // attempt's timeline so the UI only shows the current attempt. We keep
    // the document_error rows so the audit history of past failures stays.
    const isRetry = doc.status !== DocStatus.CREATED;
    if (isRetry) {
      await this.timelineRepo.delete({ documentId });
      await this.addTimeline(documentId, 'received', TimelineStepStatus.COMPLETED,
        0, `Reintento iniciado (intento ${doc.retries + 1})`);
    }

    let stepOrder = 1;

    try {
      // -- Step 1: Generate XML (or use pre-built XML from payload) --
      let xml: string;
      const rawXml = doc.payload?._rawXml;

      if (rawXml) {
        // XML was provided directly via /documents/xml endpoint — skip generation
        const xmlStartTime = Date.now();
        await this.addTimeline(documentId, 'xml_generated', TimelineStepStatus.CURRENT,
          stepOrder++, 'Validando XML recibido');
        xml = injectRucProveedorIntoRawXml(rawXml);
        await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
          'XML recibido directamente', Date.now() - xmlStartTime);
      } else {
        const xmlStartTime = Date.now();
        await this.addTimeline(documentId, 'xml_generated', TimelineStepStatus.CURRENT,
          stepOrder++, 'Generando XML');
        const xmlData = this.buildXmlData(doc);
        xml = this.xmlService.generate(doc.typeCode, xmlData);
        await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
          'XML generado correctamente', Date.now() - xmlStartTime);
      }

      // -- Step 2: Sign XML --
      const signStartTime = Date.now();
      await this.addTimeline(documentId, 'signed', TimelineStepStatus.CURRENT,
        stepOrder++, 'Firmando XML con certificado digital');

      const cert = await this.getActiveCertificate(doc.companyId);
      const p12Buffer = this.cryptoService.decrypt(cert.p12Encrypted!, cert.p12Iv!);
      const [encPwd, ivPwd] = cert.passwordEnc.split(':');
      const p12Password = this.cryptoService.decryptString(encPwd, ivPwd);
      const signedXml = this.signingService.sign(xml, p12Buffer, p12Password);

      await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
        'XML firmado correctamente', Date.now() - signStartTime);

      // -- Step 2b: Upload signed XML to S3 --
      try {
        const signedUpload = await this.s3Service.uploadXml(
          doc.company.ruc, doc.accessKey, 'signed', signedXml,
        );
        await this.upsertFile(documentId, DocFileType.SIGNED_XML, signedUpload, 'application/xml');
      } catch (s3Err: any) {
        this.logger.warn(`Failed to upload signed XML to S3: ${s3Err.message}`);
      }

      // -- Step 3: Send to SRI --
      const sriStartTime = Date.now();
      await this.addTimeline(documentId, 'sent_sri', TimelineStepStatus.CURRENT,
        stepOrder++, 'Enviando al SRI');

      // Pre-check: if this is a retry (doc was previously sent to SRI), check if
      // SRI already has/authorized it BEFORE re-sending. This avoids the common
      // error 70 loop where SRI returns "en procesamiento" because it already
      // received the access key from the previous attempt.
      if (doc.retries > 0) {
        this.logger.log(`Document ${documentId}: retry #${doc.retries}, checking SRI before re-sending`);
        try {
          const preCheck = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
          if (preCheck.authorized) {
            this.logger.log(`Document ${documentId}: already authorized at SRI on pre-check`);
            return this.handleAuthorized(documentId, doc, signedXml, preCheck, stepOrder, startTime, sriStartTime);
          }
          if (preCheck.state === 'NO AUTORIZADO') {
            // Definitively rejected — no point re-sending
            this.logger.log(`Document ${documentId}: NO AUTORIZADO at SRI, recording rejection`);
            await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
              'No autorizado por el SRI', Date.now() - sriStartTime);
            for (const msg of preCheck.messages) {
              await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, 'client');
              collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
            }
            await this.docRepo.update(documentId, {
              status: DocStatus.REJECTED, retries: doc.retries + 1, processingTimeMs: Date.now() - startTime,
            });
            this.emitStatusChange(doc, 'REJECTED');
      this.sendRejectionNotification(doc, collectedErrors);
            return { status: 'rejected', errors: collectedErrors, processingTimeMs: Date.now() - startTime };
          }
          // SRI knows about it (state != UNKNOWN) — skip reception, go to auth check
          if (preCheck.state !== 'UNKNOWN' || preCheck.messages.length > 0) {
            this.logger.log(`Document ${documentId}: SRI has it (state=${preCheck.state}), skipping reception`);
            await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
              'Clave de acceso ya registrada en el SRI (reintento)', Date.now() - sriStartTime);
            await this.docRepo.update(documentId, { status: DocStatus.RECEIVED });
            // Jump straight to Step 4 (auth check) below
            // We need to skip the reception block, so use a goto-like pattern
            return this.checkAuthorizationAndFinish(
              documentId, doc, signedXml, stepOrder, startTime, collectedErrors,
            );
          }
          this.logger.log(`Document ${documentId}: SRI doesn't have it (UNKNOWN), proceeding with re-send`);
        } catch (preCheckErr: any) {
          this.logger.warn(`Document ${documentId}: pre-check failed (${preCheckErr.message}), proceeding with re-send`);
        }
      }

      const receptionFirstSendTime = Date.now();
      let receptionResult = await this.sriService.sendToReception(signedXml, doc.env);
      this.logger.log(`Document ${documentId}: initial reception → accepted=${receptionResult.accepted}, state=${receptionResult.state}, elapsed=${Date.now() - receptionFirstSendTime}ms`);

      // Classify errors using SRI error map for smart handling
      if (!receptionResult.accepted) {
        const action = classifySriMessages(receptionResult.messages);
        this.logger.log(`Document ${documentId}: reception action=${action}, errors=[${receptionResult.messages.map(m => `${m.identifier}:${m.message}`).join(', ')}]`);

        // RETRY: error 70 (clave en procesamiento) or 69 (SRI internal error).
        // Error 70 = SRI is still processing the RECEPTION — keep re-sending until RECIBIDA.
        // Don't check auth mid-loop: it always returns UNKNOWN while reception is pending.
        if (action === SriErrorAction.RETRY) {
          let receptionAttempts = 0;
          // Total wait: ~86s (3+5+8+10+15+20+25) — enough for SRI test env
          const RECEPTION_DELAYS = [3000, 5000, 8000, 10_000, 15_000, 20_000, 25_000];

          while (
            !receptionResult.accepted &&
            classifySriMessages(receptionResult.messages) === SriErrorAction.RETRY &&
            receptionAttempts < RECEPTION_DELAYS.length
          ) {
            const delay = RECEPTION_DELAYS[receptionAttempts];
            receptionAttempts++;
            this.logger.log(`Document ${documentId}: reception retry ${receptionAttempts}/${RECEPTION_DELAYS.length}, waiting ${delay / 1000}s (elapsed: ${((Date.now() - receptionFirstSendTime) / 1000).toFixed(1)}s)`);
            await this.sleep(delay);
            receptionResult = await this.sriService.sendToReception(signedXml, doc.env);
            const newAction = classifySriMessages(receptionResult.messages);
            this.logger.log(`Document ${documentId}: reception retry ${receptionAttempts} → accepted=${receptionResult.accepted}, state=${receptionResult.state}, action=${newAction}, elapsed=${((Date.now() - receptionFirstSendTime) / 1000).toFixed(1)}s`);
          }

          if (receptionResult.accepted) {
            await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
              'Recibido por el SRI', Date.now() - sriStartTime);
            await this.docRepo.update(documentId, { status: DocStatus.RECEIVED });
          } else if (classifySriMessages(receptionResult.messages) === SriErrorAction.RETRY) {
            // Exhausted retries — one final auth check as fallback
            this.logger.warn(`Document ${documentId}: reception pending after ${receptionAttempts} retries (${((Date.now() - receptionFirstSendTime) / 1000).toFixed(1)}s), fallback auth check`);
            const fallbackAuth = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
            this.logger.log(`Document ${documentId}: fallback auth → state=${fallbackAuth.state}, authorized=${fallbackAuth.authorized}`);

            if (fallbackAuth.authorized) {
              return this.handleAuthorized(documentId, doc, signedXml, fallbackAuth, stepOrder, startTime, sriStartTime);
            }
            if (fallbackAuth.state === 'NO AUTORIZADO') {
              await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
                'No autorizado por el SRI', Date.now() - sriStartTime);
              for (const msg of fallbackAuth.messages) {
                await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, 'client');
                collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
              }
              await this.docRepo.update(documentId, {
                status: DocStatus.REJECTED, retries: doc.retries + 1, processingTimeMs: Date.now() - startTime,
              });
              this.emitStatusChange(doc, 'REJECTED');
      this.sendRejectionNotification(doc, collectedErrors);
              return { status: 'rejected', errors: collectedErrors, processingTimeMs: Date.now() - startTime };
            }

            // Still UNKNOWN — mark as FAILED for retry later
            await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
              'SRI no aceptó el documento después de varios intentos', Date.now() - sriStartTime);
            for (const msg of receptionResult.messages) {
              await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, 'system');
              collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
            }
            await this.docRepo.update(documentId, {
              status: DocStatus.FAILED, retries: doc.retries + 1, processingTimeMs: Date.now() - startTime,
            });
            this.emitStatusChange(doc, 'FAILED');
            return { status: 'failed', errors: collectedErrors, processingTimeMs: Date.now() - startTime };
          } else {
            // Error changed to non-RETRY — handle by new action
            const newAction = classifySriMessages(receptionResult.messages);
            return this.handleReceptionByAction(
              newAction, documentId, doc, signedXml, receptionResult,
              collectedErrors, stepOrder, startTime, sriStartTime,
            );
          }
        }
        // SKIP_TO_AUTH: error 43/45 — SRI already fully received the document, skip to auth check
        else if (action === SriErrorAction.SKIP_TO_AUTH) {
          const errCode = receptionResult.messages[0]?.identifier;
          this.logger.log(`Document ${documentId}: SRI already received this document (error ${errCode}), skipping to auth check`);
          await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
            'Clave de acceso ya registrada en el SRI', Date.now() - sriStartTime);
          await this.docRepo.update(documentId, { status: DocStatus.RECEIVED });
          // Fall through to auth check below
        }
        // ALREADY_AUTHORIZED: error 35 — document was already authorized, just fetch it
        else if (action === SriErrorAction.ALREADY_AUTHORIZED) {
          this.logger.log(`Document ${documentId}: already authorized (error 35), fetching authorization`);
          const authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
          if (authResult.authorized) {
            return this.handleAuthorized(documentId, doc, signedXml, authResult, stepOrder, startTime, sriStartTime);
          }
          // Weird: error 35 but not actually authorized. Proceed to auth check.
          await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
            'Documento reportado como ya autorizado, verificando', Date.now() - sriStartTime);
          await this.docRepo.update(documentId, { status: DocStatus.RECEIVED });
        }
        // NEED_NEW_KEY: error 36 — access key was burned, need to regenerate
        else if (action === SriErrorAction.NEED_NEW_KEY) {
          this.logger.warn(`Document ${documentId}: access key burned (error 36), needs new key`);
          await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
            'Clave de acceso ya utilizada y devuelta. Se necesita nueva clave.', Date.now() - sriStartTime);
          for (const msg of receptionResult.messages) {
            await this.addError(documentId, msg.identifier, msg.message,
              'La clave de acceso fue usada previamente y devuelta por el SRI. El documento necesita una nueva clave.', 'system');
            collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
          }
          await this.docRepo.update(documentId, {
            status: DocStatus.FAILED, retries: doc.retries + 1, processingTimeMs: Date.now() - startTime,
          });
          this.emitStatusChange(doc, 'FAILED');
          return { status: 'failed', errors: collectedErrors, processingTimeMs: Date.now() - startTime };
        }
        // REJECT: payload/validation errors — user must fix
        else {
          return this.handleReceptionByAction(
            action, documentId, doc, signedXml, receptionResult,
            collectedErrors, stepOrder, startTime, sriStartTime,
          );
        }
      } else {
        await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
          'Recibido por el SRI', Date.now() - sriStartTime);
        await this.docRepo.update(documentId, { status: DocStatus.RECEIVED });
      }

      // -- Step 4: Check Authorization --
      const authStartTime = Date.now();
      const totalElapsedAtAuthStart = ((authStartTime - startTime) / 1000).toFixed(1);
      this.logger.log(`Document ${documentId}: entering auth check phase (total elapsed: ${totalElapsedAtAuthStart}s)`);
      await this.addTimeline(documentId, 'sri_received', TimelineStepStatus.CURRENT,
        stepOrder++, 'Consultando autorización');

      await this.sleep(2000);

      let authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
      this.logger.log(`Document ${documentId}: auth check 1 → state=${authResult.state}, authorized=${authResult.authorized}, messages=[${authResult.messages.map(m => `${m.identifier}:${m.message}`).join(', ')}], elapsed=${((Date.now() - authStartTime) / 1000).toFixed(1)}s`);

      // Retry authorization check with progressive delays
      // Total wait: 2s + 3s + 5s + 5s + 8s + 10s + 10s + 15s ≈ 58s
      const AUTH_DELAYS = [3000, 5000, 5000, 8000, 10_000, 10_000, 15_000];
      let authAttempts = 0;
      while (!authResult.authorized && this.isSriStillProcessing(authResult) && authAttempts < AUTH_DELAYS.length) {
        this.logger.log(`Document ${documentId}: auth still processing, waiting ${AUTH_DELAYS[authAttempts] / 1000}s (auth elapsed: ${((Date.now() - authStartTime) / 1000).toFixed(1)}s, total: ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
        await this.sleep(AUTH_DELAYS[authAttempts]);
        authAttempts++;
        authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
        this.logger.log(`Document ${documentId}: auth check ${authAttempts + 1} → state=${authResult.state}, authorized=${authResult.authorized}, messages=[${authResult.messages.map(m => `${m.identifier}:${m.message}`).join(', ')}], auth elapsed=${((Date.now() - authStartTime) / 1000).toFixed(1)}s`);
      }

      if (authResult.authorized) {
        this.logger.log(`Document ${documentId}: AUTHORIZED after ${authAttempts + 1} auth checks (auth phase: ${((Date.now() - authStartTime) / 1000).toFixed(1)}s, total: ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
        return this.handleAuthorized(documentId, doc, signedXml, authResult, stepOrder, startTime, authStartTime);
      }

      // SRI still processing after retries — mark as FAILED so user knows it didn't go through
      if (this.isSriStillProcessing(authResult)) {
        this.logger.warn(`Document ${documentId}: STILL PROCESSING after ${authAttempts + 1} auth checks (auth phase: ${((Date.now() - authStartTime) / 1000).toFixed(1)}s, total: ${((Date.now() - startTime) / 1000).toFixed(1)}s). Last state=${authResult.state}`);

        await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
          'El SRI no respondió a tiempo — reintente el documento', Date.now() - authStartTime);

        await this.addError(documentId, 'SRI_TIMEOUT',
          'El SRI no procesó el documento dentro del tiempo esperado',
          `Último estado: ${authResult.state}. El documento puede haber sido recibido por el SRI. Reintente y el sistema verificará automáticamente.`,
          'system');

        collectedErrors.push({
          code: 'SRI_TIMEOUT',
          message: 'El SRI no procesó el documento dentro del tiempo esperado',
          detail: `Último estado: ${authResult.state}`,
        });

        await this.docRepo.update(documentId, {
          status: DocStatus.FAILED,
          retries: doc.retries + 1,
          processingTimeMs: Date.now() - startTime,
        });

        this.emitStatusChange(doc, 'FAILED');

        return {
          status: 'failed',
          errors: collectedErrors,
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Definitively not authorized
      await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
        `No autorizado: ${authResult.state}`, Date.now() - authStartTime);

      for (const msg of authResult.messages) {
        await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, 'client');
        collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
      }

      await this.addTimeline(documentId, 'rejected', TimelineStepStatus.ERROR,
        stepOrder++, 'Documento no autorizado por el SRI');

      await this.docRepo.update(documentId, {
        status: DocStatus.REJECTED,
        retries: doc.retries + 1,
        processingTimeMs: Date.now() - startTime,
      });

      this.emitStatusChange(doc, 'REJECTED');
      this.sendRejectionNotification(doc, collectedErrors);

      return {
        status: 'rejected',
        errors: collectedErrors,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.logger.error(`Error processing document ${documentId}: ${error.message}`, error.stack);

      await this.addTimeline(documentId, 'failed', TimelineStepStatus.ERROR,
        stepOrder++, `Error: ${error.message}`);

      await this.addError(documentId, 'SYS001', error.message, error.stack, 'system');

      await this.docRepo.update(documentId, {
        status: DocStatus.FAILED,
        retries: doc.retries + 1,
        processingTimeMs: Date.now() - startTime,
      });

      this.emitStatusChange(doc, 'FAILED');

      // Alert superadmin(s) by email — fire-and-forget so it never breaks the pipeline.
      this.notificationService
        .sendSystemErrorAlert({
          documentId,
          accessKey: doc.accessKey,
          sequential: doc.sequential,
          docType: doc.typeCode,
          companyName: doc.company?.name ?? `Empresa ${doc.companyId}`,
          companyRuc: doc.company?.ruc ?? '',
          env: doc.env,
          errorMessage: error.message,
          errorDetail: error.stack,
          failedAt: new Date(),
        })
        .catch((err) =>
          this.logger.error(`Failed to send system-error alert for doc ${documentId}: ${err.message}`),
        );

      collectedErrors.push({ code: 'SYS001', message: error.message });

      return {
        status: 'failed',
        errors: collectedErrors,
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Retry only the authorization check for a document already sent to SRI (status RECEIVED).
   * Used by the delayed auth-check job and the manual retry endpoint.
   */
  async retryAuthorization(documentId: number): Promise<ProcessingResult> {
    const startTime = Date.now();

    const doc = await this.docRepo.findOne({
      where: { id: documentId },
      relations: ['company'],
    });

    if (!doc) {
      throw new Error(`Document ${documentId} not found`);
    }

    if (doc.status !== DocStatus.RECEIVED) {
      throw new Error(`Document ${documentId} is in state ${doc.status}, expected RECEIVED`);
    }

    try {
      this.logger.log(`Document ${documentId}: retryAuthorization — accessKey=${doc.accessKey}, env=${doc.env}, retries=${doc.retries}`);
      const authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
      this.logger.log(`Document ${documentId}: retryAuthorization result → state=${authResult.state}, authorized=${authResult.authorized}, messages=[${authResult.messages.map(m => `${m.identifier}:${m.message}`).join(', ')}]`);

      if (authResult.authorized) {
        // Find last step order from timeline
        const lastTimeline = await this.timelineRepo.findOne({
          where: { documentId },
          order: { order: 'DESC' },
        });
        const stepOrder = (lastTimeline?.order ?? 4) + 1;

        return this.handleAuthorized(documentId, doc, null, authResult, stepOrder, startTime, startTime);
      }

      if (this.isSriStillProcessing(authResult)) {
        this.logger.log(`Document ${documentId}: retryAuthorization — still processing (state=${authResult.state})`);
        return {
          status: 'processing',
          errors: [],
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Definitively rejected
      const collectedErrors: ProcessingResult['errors'] = [];
      for (const msg of authResult.messages) {
        await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, 'client');
        collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
      }

      await this.docRepo.update(documentId, {
        status: DocStatus.REJECTED,
        retries: doc.retries + 1,
        processingTimeMs: Date.now() - startTime,
      });

      this.emitStatusChange(doc, 'REJECTED');
      this.sendRejectionNotification(doc, collectedErrors);

      return {
        status: 'rejected',
        errors: collectedErrors,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.logger.error(`Error retrying auth for document ${documentId}: ${error.message}`);
      return {
        status: 'processing', // Keep as processing — will retry again
        errors: [{ code: 'SYS002', message: error.message }],
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  // -- Private helpers --

  /**
   * Handle a rejected reception based on the classified SRI error action.
   * Used for REJECT and FATAL actions.
   */
  private async handleReceptionByAction(
    action: SriErrorAction,
    documentId: number,
    doc: Document,
    _signedXml: string,
    receptionResult: { state: string; messages: Array<{ identifier: string; message: string; additionalInfo: string }> },
    collectedErrors: ProcessingResult['errors'],
    stepOrder: number,
    startTime: number,
    sriStartTime: number,
  ): Promise<ProcessingResult> {
    const category = action === SriErrorAction.FATAL ? 'system' : 'client';
    const status = action === SriErrorAction.FATAL ? DocStatus.FAILED : DocStatus.REJECTED;
    const resultStatus = action === SriErrorAction.FATAL ? 'failed' : 'rejected';

    await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
      `SRI rechazó la recepción: ${receptionResult.state}`, Date.now() - sriStartTime);

    for (const msg of receptionResult.messages) {
      await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, category);
      collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
    }

    await this.docRepo.update(documentId, {
      status, retries: doc.retries + 1, processingTimeMs: Date.now() - startTime,
    });

    await this.addTimeline(documentId, 'rejected', TimelineStepStatus.ERROR,
      stepOrder, 'Documento rechazado por el SRI');

    this.emitStatusChange(doc, status);

    return {
      status: resultStatus as ProcessingResult['status'],
      errors: collectedErrors,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Run the authorization check flow (Step 4) as a standalone operation.
   * Used when we skip reception (e.g., pre-check found the document already at SRI).
   */
  private async checkAuthorizationAndFinish(
    documentId: number,
    doc: Document,
    signedXml: string,
    stepOrder: number,
    startTime: number,
    collectedErrors: ProcessingResult['errors'],
  ): Promise<ProcessingResult> {
    const authStartTime = Date.now();
    this.logger.log(`Document ${documentId}: entering standalone auth check (total elapsed: ${((authStartTime - startTime) / 1000).toFixed(1)}s)`);
    await this.addTimeline(documentId, 'sri_received', TimelineStepStatus.CURRENT,
      stepOrder++, 'Consultando autorización');

    await this.sleep(5000);

    let authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
    this.logger.log(`Document ${documentId}: auth check 1 → state=${authResult.state}, authorized=${authResult.authorized}, messages=[${authResult.messages.map(m => `${m.identifier}:${m.message}`).join(', ')}], elapsed=${((Date.now() - authStartTime) / 1000).toFixed(1)}s`);

    const AUTH_DELAYS = [5000, 5000, 10_000, 10_000, 15_000, 15_000];
    let authAttempts = 0;
    while (!authResult.authorized && this.isSriStillProcessing(authResult) && authAttempts < AUTH_DELAYS.length) {
      this.logger.log(`Document ${documentId}: auth still processing, waiting ${AUTH_DELAYS[authAttempts] / 1000}s (auth elapsed: ${((Date.now() - authStartTime) / 1000).toFixed(1)}s, total: ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      await this.sleep(AUTH_DELAYS[authAttempts]);
      authAttempts++;
      authResult = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
      this.logger.log(`Document ${documentId}: auth check ${authAttempts + 1} → state=${authResult.state}, authorized=${authResult.authorized}, messages=[${authResult.messages.map(m => `${m.identifier}:${m.message}`).join(', ')}], auth elapsed=${((Date.now() - authStartTime) / 1000).toFixed(1)}s`);
    }

    if (authResult.authorized) {
      return this.handleAuthorized(documentId, doc, signedXml, authResult, stepOrder, startTime, authStartTime);
    }

    if (this.isSriStillProcessing(authResult)) {
      await this.updateLastTimeline(documentId, TimelineStepStatus.PENDING,
        'SRI aún procesando — se reintentará automáticamente', Date.now() - authStartTime);
      await this.docRepo.update(documentId, {
        status: DocStatus.RECEIVED, processingTimeMs: Date.now() - startTime,
      });
      this.logger.log(`Document ${documentId} still processing at SRI after ${authAttempts} auth attempts`);
      return { status: 'processing', errors: [], processingTimeMs: Date.now() - startTime };
    }

    // Definitively not authorized
    await this.updateLastTimeline(documentId, TimelineStepStatus.ERROR,
      `No autorizado: ${authResult.state}`, Date.now() - authStartTime);
    for (const msg of authResult.messages) {
      await this.addError(documentId, msg.identifier, msg.message, msg.additionalInfo, 'client');
      collectedErrors.push({ code: msg.identifier, message: msg.message, detail: msg.additionalInfo });
    }
    await this.docRepo.update(documentId, {
      status: DocStatus.REJECTED, retries: doc.retries + 1, processingTimeMs: Date.now() - startTime,
    });
    this.emitStatusChange(doc, 'REJECTED');
      this.sendRejectionNotification(doc, collectedErrors);
    return { status: 'rejected', errors: collectedErrors, processingTimeMs: Date.now() - startTime };
  }

  /**
   * Detect if SRI is still processing the document (error 70 or no definitive state).
   */
  private isSriStillProcessing(authResult: SriAuthorizationResult): boolean {
    if (authResult.state === 'NO AUTORIZADO') return false;
    if (authResult.authorized) return false;

    // Error 70 = "Clave de acceso en procesamiento"
    const hasError70 = authResult.messages.some((m) => m.identifier === '70');
    if (hasError70) return true;

    // No definitive state and no messages → still processing
    if (authResult.state === 'UNKNOWN' && authResult.messages.length === 0) return true;

    return false;
  }

  /**
   * Handle successful SRI authorization: update DB, upload files, return result.
   */
  private async handleAuthorized(
    documentId: number,
    doc: Document,
    signedXml: string | null,
    authResult: SriAuthorizationResult,
    stepOrder: number,
    startTime: number,
    authStartTime: number,
  ): Promise<ProcessingResult> {
    await this.updateLastTimeline(documentId, TimelineStepStatus.COMPLETED,
      'Autorizado por el SRI', Date.now() - authStartTime);

    await this.addTimeline(documentId, 'authorized', TimelineStepStatus.COMPLETED,
      stepOrder, `Autorización: ${authResult.authorizationNumber}`);

    await this.docRepo.update(documentId, {
      status: DocStatus.AUTHORIZED,
      authNumber: authResult.authorizationNumber ?? undefined,
      authAt: authResult.authorizedAt ? new Date(authResult.authorizedAt) : new Date(),
      billable: true,
      processingTimeMs: Date.now() - startTime,
    });

    // Upload authorized XML + generate RIDE PDF
    const files = await this.uploadAuthorizedFiles(documentId, doc, signedXml ?? '', authResult);

    // Send email to buyer if email is available
    await this.sendAuthorizationEmail(doc, authResult, files);

    this.logger.log(`Document ${documentId} AUTHORIZED — total=${Date.now() - startTime}ms, authNumber=${authResult.authorizationNumber}, authAt=${authResult.authorizedAt}`);

    this.emitStatusChange(doc, 'AUTHORIZED');

    return {
      status: 'authorized',
      authorizationNumber: authResult.authorizationNumber ?? undefined,
      authorizedAt: authResult.authorizedAt ?? new Date().toISOString(),
      errors: [],
      processingTimeMs: Date.now() - startTime,
    };
  }

  private async uploadAuthorizedFiles(
    documentId: number,
    doc: Document,
    signedXml: string,
    authResult: SriAuthorizationResult,
  ): Promise<{ xmlBuffer?: Buffer; pdfBuffer?: Buffer }> {
    let xmlBuffer: Buffer | undefined;
    let pdfBuffer: Buffer | undefined;

    // Authorized XML is CRITICAL — retry up to 3 times
    const authorizedXml = authResult.authorizedXml || signedXml;

    if (!authorizedXml) {
      this.logger.error(
        `CRITICAL: No authorized XML content available for document ${documentId} ` +
        `(SRI response had no comprobante and no local signedXml fallback) — skipping upload instead of storing an empty file.`,
      );
    } else {
      xmlBuffer = Buffer.from(authorizedXml, 'utf-8');

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const authUpload = await this.s3Service.uploadXml(
            doc.company.ruc, doc.accessKey, 'authorized', authorizedXml,
          );
          await this.upsertFile(documentId, DocFileType.AUTHORIZED_XML, authUpload, 'application/xml');
          break;
        } catch (s3Err: any) {
          this.logger.warn(`Failed to upload authorized XML (attempt ${attempt + 1}/3): ${s3Err.message}`);
          if (attempt < 2) await this.sleep(2000 * (attempt + 1));
          else this.logger.error(`CRITICAL: Authorized XML upload failed for document ${documentId} after 3 attempts`);
        }
      }
    }

    // RIDE PDF — best effort (not as critical)
    try {
      let logoBuffer: Buffer | undefined;
      if (doc.company.logoS3Key) {
        try {
          logoBuffer = await this.s3Service.download(doc.company.logoS3Key);
        } catch { /* logo not critical */ }
      }
      const rideData = this.buildRideData(doc, authResult, logoBuffer);
      pdfBuffer = await this.rideService.generate(rideData);
      const pdfUpload = await this.s3Service.uploadPdf(
        doc.company.ruc, doc.accessKey, pdfBuffer,
      );
      await this.upsertFile(documentId, DocFileType.RIDE, pdfUpload, 'application/pdf');
    } catch (pdfErr: any) {
      this.logger.warn(`Failed to generate/upload RIDE for document ${documentId}: ${pdfErr.message}`);
    }

    if (xmlBuffer || pdfBuffer) {
      this.logger.log(`Files uploaded for document ${documentId}`);
    }

    return { xmlBuffer, pdfBuffer };
  }

  private async sendAuthorizationEmail(
    doc: Document,
    authResult: SriAuthorizationResult,
    files: { xmlBuffer?: Buffer; pdfBuffer?: Buffer },
  ): Promise<void> {
    const company = doc.company;
    const emailData = {
      companyName: company.name,
      companyRuc: company.ruc,
      docType: doc.typeCode,
      sequential: doc.sequential,
      authNumber: authResult.authorizationNumber || doc.accessKey,
      authDate: authResult.authorizedAt || new Date().toISOString(),
      totalAmount: Number(doc.totalAmount).toFixed(2),
      rideBuffer: files.pdfBuffer,
      xmlBuffer: files.xmlBuffer,
    };

    // Send to buyer if company has notifyClient enabled and buyer email exists
    if (company.notifyClient) {
      const buyerEmail = doc.payload?.emailComprador;
      if (buyerEmail) {
        try {
          await this.mailService.sendDocumentAuthorized({
            ...emailData,
            buyerName: doc.buyerName || 'Cliente',
            buyerEmail,
          });
        } catch (err: any) {
          this.logger.warn(`Failed to send buyer email for doc ${doc.id}: ${err.message}`);
        }
      }
    }

    // Send to company if notifyCompany enabled and company email exists
    if (company.notifyCompany && company.email) {
      try {
        await this.mailService.sendDocumentAuthorizedToCompany({
          ...emailData,
          companyEmail: company.email,
          buyerName: doc.buyerName || 'CONSUMIDOR FINAL',
          buyerId: doc.buyerId || '9999999999999',
        });
      } catch (err: any) {
        this.logger.warn(`Failed to send company email for doc ${doc.id}: ${err.message}`);
      }
    }
  }

  private async getActiveCertificate(companyId: number): Promise<Certificate> {
    const cert = await this.certRepo
      .createQueryBuilder('c')
      .addSelect('c.p12Encrypted')
      .addSelect('c.p12Iv')
      .addSelect('c.passwordEnc')
      .where('c.companyId = :companyId', { companyId })
      .andWhere('c.isCurrent = true')
      .getOne();

    if (!cert) {
      throw new Error(`No hay certificado activo para la empresa ${companyId}`);
    }

    if (cert.expiresAt && new Date(cert.expiresAt) < new Date()) {
      throw new Error('El certificado digital ha expirado');
    }

    return cert;
  }

  private async addTimeline(
    documentId: number, step: string, status: TimelineStepStatus,
    order: number, description: string,
  ): Promise<void> {
    await this.timelineRepo.save({ documentId, step, status, order, description, timestamp: new Date() });
  }

  private async updateLastTimeline(
    documentId: number, status: TimelineStepStatus,
    description: string, durationMs: number,
  ): Promise<void> {
    const last = await this.timelineRepo.findOne({
      where: { documentId },
      order: { order: 'DESC' },
    });
    if (last) {
      last.status = status;
      last.description = description;
      last.durationMs = durationMs;
      last.timestamp = new Date();
      await this.timelineRepo.save(last);
    }
  }

  private async addError(
    documentId: number, code: string, message: string,
    detail: string, category: 'client' | 'system',
  ): Promise<void> {
    await this.errorRepo.save({
      documentId,
      code: code || 'UNKNOWN',
      message: message?.substring(0, 500) || 'Error desconocido',
      detail: detail || undefined,
      category: category === 'client' ? SriErrorCategory.CLIENT : SriErrorCategory.SYSTEM,
      severity: category === 'system' ? SriErrorSeverity.CRITICAL : SriErrorSeverity.ERROR,
      billable: false,
    });
  }

  /**
   * Build the complete data object for XML generation.
   * Merges company info (infoTributaria) + document metadata + client payload.
   */
  private buildXmlData(doc: Document): any {
    const company = doc.company;
    const payload = doc.payload;

    // Shared infoTributaria fields
    const base = {
      ambiente: doc.env === 'production' ? '2' : '1',
      razonSocial: company.name,
      nombreComercial: company.tradeName || undefined,
      ruc: company.ruc,
      claveAcceso: doc.accessKey,
      establecimiento: doc.establishment,
      puntoEmision: doc.emissionPoint,
      secuencial: doc.sequential.split('-').pop() || doc.sequential,
      dirMatriz: company.address || 'ECUADOR',
      contribuyenteRimpe: payload.contribuyenteRimpe || undefined,
      agenteRetencion: payload.agenteRetencion || undefined,
      fechaEmision: payload.fechaEmision,
      dirEstablecimiento: payload.dirEstablecimiento || company.address || undefined,
      contribuyenteEspecial: payload.contribuyenteEspecial || undefined,
      obligadoContabilidad: payload.obligadoContabilidad || 'NO',
      infoAdicional: withRucProveedor(payload.infoAdicional),
    };

    if (doc.typeCode === '07') {
      // Retención v2.0.0 XML data — group impuestos by document sustento
      const tipoIdComprador = payload.tipoIdentificacionComprador;
      // tipoSujetoRetenido: solo incluir para identificación del exterior (08)
      // Para domésticos (04=RUC, 05=cédula) el SRI lo rechaza si se incluye
      const tipoSujetoRetenido = payload.tipoSujetoRetenido || undefined;

      // Group impuestosRetencion by source document
      const impuestosRetencion = payload.impuestosRetencion || [];
      const groupedMap = new Map<string, any[]>();
      for (const imp of impuestosRetencion) {
        const key = `${imp.codDocSustento}|${imp.numDocSustento}|${imp.fechaEmisionDocSustento}`;
        if (!groupedMap.has(key)) groupedMap.set(key, []);
        groupedMap.get(key)!.push(imp);
      }

      const docsSustento = Array.from(groupedMap.entries()).map(([, impuestos]) => {
        const first = impuestos[0];
        const retenciones = impuestos.map((i: any) => ({
          codigo: i.codigo,
          codigoRetencion: i.codigoRetencion,
          baseImponible: Number(i.baseImponible),
          porcentajeRetener: Number(i.porcentajeRetener),
          valorRetenido: Number(i.valorRetenido),
        }));

        // Derive impuestosDocSustento if not provided
        let impuestosDocSustento = first.impuestosDocSustento;
        if (!impuestosDocSustento || impuestosDocSustento.length === 0) {
          impuestosDocSustento = this.deriveImpuestosDocSustento(impuestos);
        }

        const rentaRet = impuestos.find((i: any) => i.codigo === '1');
        const totalSinImpuestos = first.totalSinImpuestos != null
          ? Number(first.totalSinImpuestos)
          : (rentaRet ? Number(rentaRet.baseImponible) : Number(first.baseImponible));

        const totalImpuestos = impuestosDocSustento.reduce(
          (sum: number, i: any) => sum + Number(i.valorImpuesto), 0,
        );
        const importeTotal = first.importeTotal != null
          ? Number(first.importeTotal)
          : totalSinImpuestos + totalImpuestos;

        const ds: any = {
          codSustento: first.codSustento || '01',
          codDocSustento: first.codDocSustento,
          numDocSustento: first.numDocSustento,
          fechaEmisionDocSustento: first.fechaEmisionDocSustento,
          fechaRegistroContable: first.fechaRegistroContable || first.fechaEmisionDocSustento,
          pagoLocExt: first.pagoLocExt || '01',
          totalSinImpuestos,
          importeTotal,
          impuestosDocSustento: impuestosDocSustento.map((i: any) => ({
            codImpuestoDocSustento: i.codImpuestoDocSustento,
            codigoPorcentaje: i.codigoPorcentaje,
            baseImponible: Number(i.baseImponible),
            tarifa: Number(i.tarifa),
            valorImpuesto: Number(i.valorImpuesto),
          })),
          retenciones,
        };
        if (first.numAutDocSustento) {
          ds.numAutDocSustento = first.numAutDocSustento;
        }
        // pagos is REQUIRED in v2.0.0 — always include at least one
        ds.pagos = [{
          formaPago: first.formaPago || '20',
          total: first.totalPago != null ? Number(first.totalPago) : importeTotal,
        }];
        return ds;
      });

      return {
        ...base,
        tipoIdentificacionSujetoRetenido: tipoIdComprador,
        tipoSujetoRetenido,
        parteRel: payload.parteRel || 'NO',
        razonSocialSujetoRetenido: payload.razonSocialComprador,
        identificacionSujetoRetenido: payload.identificacionComprador,
        periodoFiscal: payload.periodoFiscal,
        docsSustento,
      };
    }

    if (doc.typeCode === '04') {
      // Nota de Crédito XML data
      return {
        ...base,
        tipoIdentificacionComprador: payload.tipoIdentificacionComprador,
        razonSocialComprador: payload.razonSocialComprador,
        identificacionComprador: payload.identificacionComprador,
        rise: payload.contribuyenteRimpe || undefined,
        codDocModificado: payload.codDocModificado,
        numDocModificado: payload.numDocModificado,
        fechaEmisionDocSustento: payload.fechaEmisionDocSustento,
        totalSinImpuestos: Number(payload.totalSinImpuestos),
        valorModificacion: Number(payload.valorModificacion),
        moneda: payload.moneda || 'DOLAR',
        totalConImpuestos: (payload.totalConImpuestos || []).map((t: any) => ({
          codigo: t.codigo,
          codigoPorcentaje: t.codigoPorcentaje,
          baseImponible: Number(t.baseImponible),
          valor: Number(t.valor),
        })),
        motivo: payload.motivo,
        detalles: (payload.detalles || []).map((d: any) => ({
          codigoInterno: d.codigoPrincipal || undefined,
          codigoAdicional: d.codigoAuxiliar || undefined,
          descripcion: d.descripcion,
          cantidad: Number(d.cantidad),
          precioUnitario: Number(d.precioUnitario),
          descuento: d.descuento != null ? Number(d.descuento) : undefined,
          precioTotalSinImpuesto: Number(d.precioTotalSinImpuesto),
          detallesAdicionales: d.detallesAdicionales || undefined,
          impuestos: (d.impuestos || []).map((i: any) => ({
            codigo: i.codigo,
            codigoPorcentaje: i.codigoPorcentaje,
            tarifa: Number(i.tarifa),
            baseImponible: Number(i.baseImponible),
            valor: Number(i.valor),
          })),
        })),
      };
    }

    if (doc.typeCode === '05') {
      // Nota de Débito XML data
      return {
        ...base,
        tipoIdentificacionComprador: payload.tipoIdentificacionComprador,
        razonSocialComprador: payload.razonSocialComprador,
        identificacionComprador: payload.identificacionComprador,
        rise: payload.contribuyenteRimpe || undefined,
        codDocModificado: payload.codDocModificado,
        numDocModificado: payload.numDocModificado,
        fechaEmisionDocSustento: payload.fechaEmisionDocSustento,
        totalSinImpuestos: Number(payload.totalSinImpuestos),
        totalConImpuestos: (payload.totalConImpuestos || []).map((t: any) => ({
          codigo: t.codigo,
          codigoPorcentaje: t.codigoPorcentaje,
          baseImponible: Number(t.baseImponible),
          tarifa: Number(t.tarifa ?? t.valor > 0 ? ((t.valor / t.baseImponible) * 100) : 0),
          valor: Number(t.valor),
        })),
        valorTotal: Number(payload.valorTotal),
        pagos: (payload.pagos || []).map((p: any) => ({
          formaPago: p.formaPago,
          total: Number(p.total),
          plazo: p.plazo ? Number(p.plazo) : undefined,
          unidadTiempo: p.unidadTiempo || undefined,
        })),
        motivos: (payload.motivos || []).map((m: any) => ({
          razon: m.razon,
          valor: Number(m.valor),
        })),
      };
    }

    if (doc.typeCode === '03') {
      // Liquidación de Compras XML data
      // Maps comprador → proveedor (LC is issued by buyer to informal provider)
      return {
        ...base,
        tipoIdentificacionProveedor: payload.tipoIdentificacionComprador,
        razonSocialProveedor: payload.razonSocialComprador,
        identificacionProveedor: payload.identificacionComprador,
        direccionProveedor: payload.direccionComprador || undefined,
        totalSinImpuestos: Number(payload.totalSinImpuestos),
        totalDescuento: Number(payload.totalDescuento),
        totalConImpuestos: (payload.totalConImpuestos || []).map((t: any) => ({
          codigo: t.codigo,
          codigoPorcentaje: t.codigoPorcentaje,
          descuentoAdicional: t.descuentoAdicional != null ? Number(t.descuentoAdicional) : undefined,
          baseImponible: Number(t.baseImponible),
          valor: Number(t.valor),
        })),
        importeTotal: Number(payload.importeTotal),
        moneda: payload.moneda || 'DOLAR',
        pagos: (payload.pagos || []).map((p: any) => ({
          formaPago: p.formaPago,
          total: Number(p.total),
          plazo: p.plazo ? Number(p.plazo) : undefined,
          unidadTiempo: p.unidadTiempo || undefined,
        })),

        // reembolsos (optional)
        ...(payload.reembolsos && payload.reembolsos.length > 0 ? (() => {
          const reembolsos = payload.reembolsos.map((r: any) => ({
            tipoIdentificacionProveedorReembolso: r.tipoIdentificacionProveedorReembolso,
            identificacionProveedorReembolso: r.identificacionProveedorReembolso,
            codPaisProveedorReembolso: r.codPaisProveedorReembolso,
            tipoProveedorReembolso: r.tipoProveedorReembolso,
            codDocReembolso: r.codDocReembolso,
            estabDocReembolso: r.estabDocReembolso,
            ptoEmiDocReembolso: r.ptoEmiDocReembolso,
            secuencialDocReembolso: r.secuencialDocReembolso,
            fechaEmisionDocReembolso: r.fechaEmisionDocReembolso,
            numeroautorizacionDocReemb: r.numeroautorizacionDocReemb,
            detalleImpuestos: (r.detalleImpuestos || []).map((i: any) => ({
              codigo: i.codigo,
              codigoPorcentaje: i.codigoPorcentaje,
              tarifa: Number(i.tarifa),
              baseImponibleReembolso: Number(i.baseImponibleReembolso),
              impuestoReembolso: Number(i.impuestoReembolso),
            })),
          }));
          let totalBase = 0;
          let totalImpuesto = 0;
          for (const r of reembolsos) {
            for (const i of r.detalleImpuestos) {
              totalBase += i.baseImponibleReembolso;
              totalImpuesto += i.impuestoReembolso;
            }
          }
          return {
            codDocReemb: '41',
            totalComprobantesReembolso: totalBase + totalImpuesto,
            totalBaseImponibleReembolso: totalBase,
            totalImpuestoReembolso: totalImpuesto,
            reembolsos,
          };
        })() : {}),

        detalles: (payload.detalles || []).map((d: any) => ({
          codigoPrincipal: d.codigoPrincipal,
          codigoAuxiliar: d.codigoAuxiliar || undefined,
          descripcion: d.descripcion,
          cantidad: Number(d.cantidad),
          precioUnitario: Number(d.precioUnitario),
          descuento: Number(d.descuento),
          precioTotalSinImpuesto: Number(d.precioTotalSinImpuesto),
          detallesAdicionales: d.detallesAdicionales || undefined,
          impuestos: (d.impuestos || []).map((i: any) => ({
            codigo: i.codigo,
            codigoPorcentaje: i.codigoPorcentaje,
            tarifa: Number(i.tarifa),
            baseImponible: Number(i.baseImponible),
            valor: Number(i.valor),
          })),
        })),
      };
    }

    if (doc.typeCode === '06') {
      // Guía de Remisión XML data
      return {
        ...base,
        dirPartida: payload.dirPartida,
        razonSocialTransportista: payload.razonSocialTransportista,
        tipoIdentificacionTransportista: payload.tipoIdentificacionTransportista,
        rucTransportista: payload.rucTransportista,
        rise: payload.contribuyenteRimpe || undefined,
        fechaIniTransporte: payload.fechaIniTransporte,
        fechaFinTransporte: payload.fechaFinTransporte,
        placa: payload.placa,
        destinatarios: (payload.destinatarios || []).map((dest: any) => ({
          identificacionDestinatario: dest.identificacionDestinatario,
          razonSocialDestinatario: dest.razonSocialDestinatario,
          dirDestinatario: dest.dirDestinatario,
          motivoTraslado: dest.motivoTraslado,
          docAduaneroUnico: dest.docAduaneroUnico || undefined,
          codEstabDestino: dest.codEstabDestino || undefined,
          ruta: dest.ruta || undefined,
          codDocSustento: dest.codDocSustento || undefined,
          numDocSustento: dest.numDocSustento || undefined,
          numAutDocSustento: dest.numAutDocSustento || undefined,
          fechaEmisionDocSustento: dest.fechaEmisionDocSustento || undefined,
          detalles: (dest.detalles || []).map((d: any) => ({
            codigoInterno: d.codigoInterno || undefined,
            codigoAdicional: d.codigoAdicional || undefined,
            descripcion: d.descripcion,
            cantidad: Number(d.cantidad),
          })),
        })),
      };
    }

    // Factura XML data (default)
    return {
      ...base,
      tipoIdentificacionComprador: payload.tipoIdentificacionComprador,
      razonSocialComprador: payload.razonSocialComprador,
      identificacionComprador: payload.identificacionComprador,
      direccionComprador: payload.direccionComprador || undefined,
      totalSinImpuestos: Number(payload.totalSinImpuestos),
      totalDescuento: Number(payload.totalDescuento),
      totalConImpuestos: (payload.totalConImpuestos || []).map((t: any) => ({
        codigo: t.codigo,
        codigoPorcentaje: t.codigoPorcentaje,
        descuentoAdicional: t.descuentoAdicional != null ? Number(t.descuentoAdicional) : undefined,
        baseImponible: Number(t.baseImponible),
        valor: Number(t.valor),
      })),
      propina: payload.propina ? Number(payload.propina) : 0,
      importeTotal: Number(payload.importeTotal),
      moneda: payload.moneda || 'DOLAR',
      valorRetIva: payload.valorRetIva != null ? Number(payload.valorRetIva) : undefined,
      valorRetRenta: payload.valorRetRenta != null ? Number(payload.valorRetRenta) : undefined,
      pagos: (payload.pagos || []).map((p: any) => ({
        formaPago: p.formaPago,
        total: Number(p.total),
        plazo: p.plazo ? Number(p.plazo) : undefined,
        unidadTiempo: p.unidadTiempo || undefined,
      })),

      // reembolsos (factura por reembolso)
      ...(payload.reembolsos && payload.reembolsos.length > 0 ? (() => {
        const reembolsos = payload.reembolsos.map((r: any) => ({
          tipoIdentificacionProveedorReembolso: r.tipoIdentificacionProveedorReembolso,
          identificacionProveedorReembolso: r.identificacionProveedorReembolso,
          codPaisProveedorReembolso: r.codPaisProveedorReembolso,
          tipoProveedorReembolso: r.tipoProveedorReembolso,
          codDocReembolso: r.codDocReembolso,
          estabDocReembolso: r.estabDocReembolso,
          ptoEmiDocReembolso: r.ptoEmiDocReembolso,
          secuencialDocReembolso: r.secuencialDocReembolso,
          fechaEmisionDocReembolso: r.fechaEmisionDocReembolso,
          numeroautorizacionDocReemb: r.numeroautorizacionDocReemb,
          detalleImpuestos: (r.detalleImpuestos || []).map((i: any) => ({
            codigo: i.codigo,
            codigoPorcentaje: i.codigoPorcentaje,
            tarifa: Number(i.tarifa),
            baseImponibleReembolso: Number(i.baseImponibleReembolso),
            impuestoReembolso: Number(i.impuestoReembolso),
          })),
        }));
        let totalBase = 0;
        let totalImpuesto = 0;
        for (const r of reembolsos) {
          for (const i of r.detalleImpuestos) {
            totalBase += i.baseImponibleReembolso;
            totalImpuesto += i.impuestoReembolso;
          }
        }
        return {
          codDocReemb: '41',
          totalComprobantesReembolso: totalBase + totalImpuesto,
          totalBaseImponibleReembolso: totalBase,
          totalImpuestoReembolso: totalImpuesto,
          reembolsos,
        };
      })() : {}),

      // detalles
      detalles: (payload.detalles || []).map((d: any) => ({
        codigoPrincipal: d.codigoPrincipal,
        codigoAuxiliar: d.codigoAuxiliar || undefined,
        descripcion: d.descripcion,
        cantidad: Number(d.cantidad),
        precioUnitario: Number(d.precioUnitario),
        descuento: Number(d.descuento),
        precioTotalSinImpuesto: Number(d.precioTotalSinImpuesto),
        detallesAdicionales: d.detallesAdicionales || undefined,
        impuestos: (d.impuestos || []).map((i: any) => ({
          codigo: i.codigo,
          codigoPorcentaje: i.codigoPorcentaje,
          tarifa: Number(i.tarifa),
          baseImponible: Number(i.baseImponible),
          valor: Number(i.valor),
        })),
      })),
    };
  }

  private buildRideData(doc: Document, authResult: any, logoBuffer?: Buffer): RideData {
    const payload = doc.payload;
    const company = doc.company;

    // Shared fields for all document types
    const base: RideData = {
      logoBuffer,
      razonSocial: company.name,
      nombreComercial: company.tradeName || undefined,
      ruc: company.ruc,
      dirMatriz: company.address || '',
      dirEstablecimiento: payload.dirEstablecimiento || company.address || '',
      obligadoContabilidad: payload.obligadoContabilidad || 'NO',
      contribuyenteRimpe: payload.contribuyenteRimpe || undefined,
      contribuyenteEspecial: payload.contribuyenteEspecial || undefined,
      agenteRetencion: payload.agenteRetencion || undefined,
      brandFooter: company.account?.rideFooter || undefined,

      codDoc: doc.typeCode,
      establecimiento: doc.establishment,
      puntoEmision: doc.emissionPoint,
      // doc.sequential is stored as "estab-punto-secuencial"; the RIDE composes the
      // number itself, so pass only the 9-digit sequential to avoid duplicating it.
      secuencial: doc.sequential.split('-').pop() || doc.sequential,
      claveAcceso: doc.accessKey,
      numeroAutorizacion: authResult.authorizationNumber || doc.accessKey,
      fechaAutorizacion: this.toEcuadorDateTime(authResult.authorizedAt || new Date().toISOString()),
      ambiente: doc.env === 'production' ? '2' : '1',

      razonSocialComprador: doc.buyerName || 'CONSUMIDOR FINAL',
      identificacionComprador: doc.buyerId || '9999999999999',
      fechaEmision: payload.fechaEmision || doc.issueDate?.toString() || '',

      // Default empty arrays for factura fields
      detalles: [],
      totalSinImpuestos: 0,
      totalDescuento: 0,
      importeTotal: 0,
      totalConImpuestos: [],
      pagos: [],

      infoAdicional: withRucProveedor(payload.infoAdicional),
    };

    if (doc.typeCode === '07') {
      // Retención-specific fields
      base.periodoFiscal = payload.periodoFiscal || '';
      base.impuestosRetencion = (payload.impuestosRetencion || []).map((i: any) => ({
        codigo: i.codigo,
        codigoRetencion: i.codigoRetencion,
        baseImponible: Number(i.baseImponible) || 0,
        porcentajeRetener: Number(i.porcentajeRetener) || 0,
        valorRetenido: Number(i.valorRetenido) || 0,
        codDocSustento: i.codDocSustento,
        numDocSustento: i.numDocSustento,
        fechaEmisionDocSustento: i.fechaEmisionDocSustento,
      }));
    } else if (doc.typeCode === '04') {
      // Nota de Crédito-specific fields
      base.codDocModificado = payload.codDocModificado || '';
      base.numDocModificado = payload.numDocModificado || '';
      base.fechaEmisionDocSustento = payload.fechaEmisionDocSustento || '';
      base.motivo = payload.motivo || '';
      base.valorModificacion = Number(payload.valorModificacion) || Number(doc.totalAmount) || 0;
      // NC also uses factura-like detalles/totals
      base.detalles = (payload.detalles || []).map((d: any) => ({
        codigoPrincipal: d.codigoPrincipal || '',
        descripcion: d.descripcion || '',
        cantidad: Number(d.cantidad) || 0,
        precioUnitario: Number(d.precioUnitario) || 0,
        descuento: Number(d.descuento) || 0,
        precioTotalSinImpuesto: Number(d.precioTotalSinImpuesto) || 0,
        impuestos: (d.impuestos || []).map((i: any) => ({
          codigoPorcentaje: i.codigoPorcentaje || '0',
          tarifa: Number(i.tarifa) || 0,
        })),
      }));
      base.totalSinImpuestos = Number(payload.totalSinImpuestos) || Number(doc.subtotal) || 0;
      base.totalDescuento = Number(payload.totalDescuento) || Number(doc.totalDiscount) || 0;
      base.importeTotal = Number(payload.valorModificacion) || Number(doc.totalAmount) || 0;
      base.totalConImpuestos = (payload.totalConImpuestos || []).map((t: any) => ({
        codigo: t.codigo || '2',
        codigoPorcentaje: t.codigoPorcentaje || '0',
        baseImponible: Number(t.baseImponible) || 0,
        valor: Number(t.valor) || 0,
      }));
      base.pagos = (payload.pagos || []).map((p: any) => ({
        formaPago: p.formaPago || '01',
        total: Number(p.total) || 0,
        plazo: p.plazo ? Number(p.plazo) : undefined,
        unidadTiempo: p.unidadTiempo || undefined,
      }));
    } else if (doc.typeCode === '05') {
      // Nota de Débito-specific fields
      base.codDocModificado = payload.codDocModificado || '';
      base.numDocModificado = payload.numDocModificado || '';
      base.fechaEmisionDocSustento = payload.fechaEmisionDocSustento || '';
      base.valorModificacion = Number(payload.valorTotal) || Number(doc.totalAmount) || 0;
      base.importeTotal = Number(payload.valorTotal) || Number(doc.totalAmount) || 0;
      base.totalSinImpuestos = Number(payload.totalSinImpuestos) || Number(doc.subtotal) || 0;
      base.totalDescuento = 0;
      base.totalConImpuestos = (payload.totalConImpuestos || []).map((t: any) => ({
        codigo: t.codigo || '2',
        codigoPorcentaje: t.codigoPorcentaje || '0',
        baseImponible: Number(t.baseImponible) || 0,
        valor: Number(t.valor) || 0,
      }));
      base.pagos = (payload.pagos || []).map((p: any) => ({
        formaPago: p.formaPago || '01',
        total: Number(p.total) || 0,
        plazo: p.plazo ? Number(p.plazo) : undefined,
        unidadTiempo: p.unidadTiempo || undefined,
      }));
      // ND motivos for RIDE
      base.motivosND = (payload.motivos || []).map((m: any) => ({
        razon: m.razon || '',
        valor: Number(m.valor) || 0,
      }));
    } else if (doc.typeCode === '06') {
      // Guía de Remisión-specific fields
      base.guiaRemisionData = {
        dirPartida: payload.dirPartida || '',
        razonSocialTransportista: payload.razonSocialTransportista || '',
        tipoIdentificacionTransportista: payload.tipoIdentificacionTransportista || '04',
        rucTransportista: payload.rucTransportista || '',
        fechaIniTransporte: payload.fechaIniTransporte || '',
        fechaFinTransporte: payload.fechaFinTransporte || '',
        placa: payload.placa || '',
        destinatarios: (payload.destinatarios || []).map((dest: any) => ({
          identificacionDestinatario: dest.identificacionDestinatario || '',
          razonSocialDestinatario: dest.razonSocialDestinatario || '',
          dirDestinatario: dest.dirDestinatario || '',
          motivoTraslado: dest.motivoTraslado || '',
          codDocSustento: dest.codDocSustento || undefined,
          numDocSustento: dest.numDocSustento || undefined,
          fechaEmisionDocSustento: dest.fechaEmisionDocSustento || undefined,
          ruta: dest.ruta || undefined,
          detalles: (dest.detalles || []).map((d: any) => ({
            codigoInterno: d.codigoInterno || undefined,
            descripcion: d.descripcion || '',
            cantidad: Number(d.cantidad) || 0,
          })),
        })),
      };
    } else {
      // Factura-specific fields
      base.detalles = (payload.detalles || []).map((d: any) => ({
        codigoPrincipal: d.codigoPrincipal || '',
        descripcion: d.descripcion || '',
        cantidad: Number(d.cantidad) || 0,
        precioUnitario: Number(d.precioUnitario) || 0,
        descuento: Number(d.descuento) || 0,
        precioTotalSinImpuesto: Number(d.precioTotalSinImpuesto) || 0,
        impuestos: (d.impuestos || []).map((i: any) => ({
          codigoPorcentaje: i.codigoPorcentaje || '0',
          tarifa: Number(i.tarifa) || 0,
        })),
      }));
      base.totalSinImpuestos = Number(payload.totalSinImpuestos) || Number(doc.subtotal) || 0;
      base.totalDescuento = Number(payload.totalDescuento) || Number(doc.totalDiscount) || 0;
      base.importeTotal = Number(payload.importeTotal) || Number(doc.totalAmount) || 0;
      base.totalConImpuestos = (payload.totalConImpuestos || []).map((t: any) => ({
        codigo: t.codigo || '2',
        codigoPorcentaje: t.codigoPorcentaje || '0',
        baseImponible: Number(t.baseImponible) || 0,
        valor: Number(t.valor) || 0,
      }));
      base.pagos = (payload.pagos || []).map((p: any) => ({
        formaPago: p.formaPago || '01',
        total: Number(p.total) || 0,
        plazo: p.plazo ? Number(p.plazo) : undefined,
        unidadTiempo: p.unidadTiempo || undefined,
      }));
    }

    return base;
  }

  /**
   * Reissue a previously failed/rejected document with today's date.
   * Consults the SRI first to avoid duplicating an already-authorized document;
   * if not authorized there, regenerates the access key with today's date,
   * resets timeline/errors/files, updates the payload's emission date, and
   * runs the full processing pipeline again.
   *
   * The sequential is preserved because rejected/failed docs do not consume it.
   */
  async reissueToday(documentId: number): Promise<{
    outcome: 'synced_authorized' | 'reissued';
    authorized: boolean;
    authorizationNumber?: string | null;
    oldAccessKey: string;
    newAccessKey?: string;
    processingResult?: ProcessingResult;
  }> {
    const doc = await this.docRepo.findOne({
      where: { id: documentId },
      relations: ['company'],
    });
    if (!doc) throw new BadRequestException('Documento no encontrado');

    const REISSUABLE: DocStatus[] = [DocStatus.REJECTED, DocStatus.FAILED];
    if (!REISSUABLE.includes(doc.status)) {
      throw new BadRequestException(
        `Solo se pueden reemitir documentos en estado REJECTED o FAILED. Estado actual: ${doc.status}.`,
      );
    }

    const company = doc.company;
    if (!company) throw new BadRequestException('Empresa no encontrada para el documento');

    // 1. Ask SRI if the existing key is already authorized — don't duplicate.
    let sriAuth: SriAuthorizationResult | null = null;
    try {
      sriAuth = await this.sriService.checkAuthorization(doc.accessKey, doc.env);
    } catch (err: any) {
      this.logger.warn(
        `reissueToday: SRI authorization consult failed for doc ${documentId}: ${err.message} — proceeding with reissue`,
      );
    }

    if (sriAuth?.authorized) {
      // SRI actually has it authorized despite our local status. Sync and stop.
      doc.status = DocStatus.AUTHORIZED;
      doc.authNumber = sriAuth.authorizationNumber ?? doc.accessKey;
      doc.authAt = sriAuth.authorizedAt ? new Date(sriAuth.authorizedAt) : new Date();
      await this.docRepo.save(doc);
      this.logger.log(
        `reissueToday: doc ${documentId} was actually AUTHORIZED at SRI (auth=${doc.authNumber}). No reissue needed.`,
      );
      return {
        outcome: 'synced_authorized',
        authorized: true,
        authorizationNumber: doc.authNumber,
        oldAccessKey: doc.accessKey,
      };
    }

    // 2. Regenerate the access key with today's date.
    const today = new Date();
    const sequentialDigits = doc.sequential.includes('-')
      ? doc.sequential.split('-').pop() ?? doc.sequential
      : doc.sequential;
    const oldAccessKey = doc.accessKey;
    const newAccessKey = this.accessKeyService.generate({
      issueDate: today,
      docType: doc.typeCode,
      ruc: company.ruc,
      env: doc.env,
      establishment: doc.establishment,
      emissionPoint: doc.emissionPoint,
      sequential: sequentialDigits,
    });

    // 3. Update the payload's emission date so the regenerated XML matches.
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = String(today.getFullYear());
    const todayDdMmYyyy = `${dd}/${mm}/${yyyy}`;

    const newPayload = { ...(doc.payload ?? {}) } as Record<string, any>;
    newPayload.fechaEmision = todayDdMmYyyy;
    if (doc.typeCode === SriDocTypeCode.GUIA_REMISION && newPayload.fechaIniTransporte) {
      newPayload.fechaIniTransporte = todayDdMmYyyy;
    }
    // Any cached _rawXml is stale — it still has the old date/key.
    if (newPayload._rawXml) delete newPayload._rawXml;
    // Drop any pending auto-retry marker — this is a fresh manual reissue.
    if (newPayload._systemRetry) delete newPayload._systemRetry;

    // 4. Clear artifacts of the previous attempts.
    await this.timelineRepo.delete({ documentId: doc.id });
    await this.errorRepo.delete({ documentId: doc.id });
    await this.fileRepo.delete({ documentId: doc.id });

    // 5. Persist the document update.
    doc.accessKey = newAccessKey;
    doc.issueDate = today;
    doc.payload = newPayload as any;
    doc.status = DocStatus.CREATED;
    doc.retries = 0;
    doc.authNumber = null as any;
    doc.authAt = null as any;
    doc.processingTimeMs = null as any;
    await this.docRepo.save(doc);

    // 6. Audit timeline entry.
    await this.timelineRepo.save({
      documentId: doc.id,
      step: 'received',
      status: TimelineStepStatus.COMPLETED,
      order: 0,
      description: `Reemitido con fecha de hoy (clave anterior: ${oldAccessKey})`,
      timestamp: new Date(),
    });

    this.logger.log(
      `reissueToday: doc ${documentId} reissued — old key ${oldAccessKey}, new key ${newAccessKey}`,
    );

    // 7. Run the full processing pipeline.
    const processingResult = await this.processDocument(doc.id);

    return {
      outcome: 'reissued',
      authorized: processingResult.status === 'authorized',
      authorizationNumber: processingResult.authorizationNumber ?? null,
      oldAccessKey,
      newAccessKey,
      processingResult,
    };
  }

  /**
   * Regenerate the RIDE PDF for an already-processed document.
   * Rebuilds the PDF from the stored payload and re-uploads to S3.
   * Maximum 3 regenerations per document.
   */
  async regenerateRide(documentId: number): Promise<Buffer> {
    const doc = await this.docRepo.findOne({
      where: { id: documentId },
      relations: ['company', 'company.account'],
    });

    if (!doc) throw new Error(`Document ${documentId} not found`);

    if ((doc.rideRegenerations ?? 0) >= 3) {
      throw new BadRequestException(
        'Se alcanzó el límite máximo de 3 regeneraciones de RIDE para este documento.',
      );
    }

    let logoBuffer: Buffer | undefined;
    if (doc.company?.logoS3Key) {
      try {
        logoBuffer = await this.s3Service.download(doc.company.logoS3Key);
      } catch { /* logo not critical */ }
    }

    const rideData = this.buildRideData(
      doc,
      { authorizationNumber: doc.authNumber, authorizedAt: doc.authAt?.toISOString?.() ?? doc.authAt },
      logoBuffer,
    );
    const pdfBuffer = await this.rideService.generate(rideData);

    // Re-upload to S3, replacing the old RIDE
    const pdfUpload = await this.s3Service.uploadPdf(
      doc.company.ruc, doc.accessKey, pdfBuffer,
    );
    await this.upsertFile(documentId, DocFileType.RIDE, pdfUpload, 'application/pdf');

    // Increment regeneration counter
    await this.docRepo.update(documentId, {
      rideRegenerations: (doc.rideRegenerations ?? 0) + 1,
    });

    this.logger.log(`RIDE regenerated for document ${documentId} (${(doc.rideRegenerations ?? 0) + 1}/3)`);
    return pdfBuffer;
  }

  private toEcuadorDateTime(isoDate: string): string {
    const d = new Date(isoDate);
    return d.toLocaleString('es-EC', {
      timeZone: 'America/Guayaquil',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  private async upsertFile(
    documentId: number,
    type: DocFileType,
    upload: { s3Key: string; sizeBytes: number; hashSha256: string },
    mimeType: string,
  ): Promise<void> {
    const existing = await this.fileRepo.findOne({ where: { documentId, type } });
    if (existing) {
      await this.fileRepo.update(existing.id, {
        s3Key: upload.s3Key,
        sizeBytes: upload.sizeBytes,
        hashSha256: upload.hashSha256,
      });
    } else {
      await this.fileRepo.save({
        documentId, type, s3Key: upload.s3Key,
        sizeBytes: upload.sizeBytes, hashSha256: upload.hashSha256, mimeType,
      });
    }
  }

  private emitStatusChange(doc: Document, status: string) {
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
    } catch (err: any) {
      this.logger.warn(`Failed to emit WS event for doc ${doc.id}: ${err.message}`);
    }
  }

  private sendRejectionNotification(
    doc: Document,
    errors: { code: string; message: string; detail?: string }[],
  ) {
    const company = doc.company;
    if (!company) return;
    this.notificationService.sendDocumentRejected({
      companyName: company.name,
      companyRuc: company.ruc,
      companyEmail: company.email,
      notificationEmail: company.notificationEmail,
      docType: doc.typeCode,
      sequential: doc.sequential,
      accessKey: doc.accessKey,
      errors,
    }).catch((err) => this.logger.warn(`Rejection notification failed for doc ${doc.id}: ${err.message}`));
  }

  /**
   * Derive impuestosDocSustento from retention data when not explicitly provided.
   * Constructs the source document's tax info from the retention entries.
   */
  private deriveImpuestosDocSustento(impuestos: any[]): any[] {
    const result: any[] = [];
    const ivaRet = impuestos.find((i: any) => i.codigo === '2');
    const rentaRet = impuestos.find((i: any) => i.codigo === '1');
    const baseSubtotal = rentaRet ? Number(rentaRet.baseImponible) : (ivaRet ? Number(ivaRet.baseImponible) : 0);

    if (ivaRet) {
      // Source doc has IVA. The IVA retention's baseImponible = the IVA amount of the source doc
      const ivaAmount = Number(ivaRet.baseImponible);
      // Try to determine the IVA tariff: ivaAmount / baseSubtotal * 100
      const tarifa = baseSubtotal > 0 ? Math.round((ivaAmount / baseSubtotal) * 100) : 15;
      result.push({
        codImpuestoDocSustento: '2',
        codigoPorcentaje: tarifa === 15 ? '4' : tarifa === 12 ? '2' : tarifa === 14 ? '3' : '4',
        baseImponible: baseSubtotal,
        tarifa,
        valorImpuesto: ivaAmount,
      });
    } else {
      // No IVA retention → source doc is IVA 0%
      result.push({
        codImpuestoDocSustento: '2',
        codigoPorcentaje: '0',
        baseImponible: baseSubtotal,
        tarifa: 0,
        valorImpuesto: 0,
      });
    }

    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
