import {
  Injectable, BadRequestException, ConflictException, ForbiddenException,
  NotFoundException, Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Document } from '../../entities/document.entity';
import { Company } from '../../entities/company.entity';
import { Certificate } from '../../entities/certificate.entity';
import { DocumentTimeline } from '../../entities/document-timeline.entity';
import { DocumentError } from '../../entities/document-error.entity';
import { DocumentFile } from '../../entities/document-file.entity';
import { EmissionPoint } from '../../entities/emission-point.entity';
import { CompanyDocType } from '../../entities/company-doc-type.entity';
import { DocStatus, SriDocTypeCode, DocFileType, TimelineStepStatus, AccessKeyMode, SequentialMode } from '../../entities/enums';
import { SequentialService } from '../../engine/sequential/sequential.service';
import { AccessKeyService } from '../../engine/sequential/access-key.service';
import { DocumentProcessingService, ProcessingResult } from '../../engine/processing/document-processing.service';
import { S3StorageService } from '../../engine/storage/s3.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { DOCUMENT_QUEUE } from '../../queues/queues.constants';
import { formatDateTz } from '../../common/utils/date.util';
import { NotificationService } from '../../notifications/notification.service';

/** States where a document can be corrected and reprocessed */
const CORRECTABLE_STATES: DocStatus[] = [DocStatus.CREATED, DocStatus.REJECTED, DocStatus.FAILED];

@Injectable()
export class PublicDocumentsService {
  private readonly logger = new Logger(PublicDocumentsService.name);

  constructor(
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(Certificate)
    private readonly certRepo: Repository<Certificate>,
    @InjectRepository(DocumentTimeline)
    private readonly timelineRepo: Repository<DocumentTimeline>,
    @InjectRepository(DocumentError)
    private readonly errorRepo: Repository<DocumentError>,
    @InjectRepository(DocumentFile)
    private readonly fileRepo: Repository<DocumentFile>,
    @InjectRepository(EmissionPoint)
    private readonly emissionPointRepo: Repository<EmissionPoint>,
    @InjectRepository(CompanyDocType)
    private readonly docTypeRepo: Repository<CompanyDocType>,
    @InjectQueue(DOCUMENT_QUEUE)
    private readonly documentQueue: Queue,
    private readonly sequentialService: SequentialService,
    private readonly accessKeyService: AccessKeyService,
    private readonly processingService: DocumentProcessingService,
    private readonly s3Service: S3StorageService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Create a new document and enqueue for async processing.
   */
  async create(company: Company, dto: CreateDocumentDto) {
    const saved = await this.createDocumentRecord(company, dto);

    // Enqueue for processing
    await this.documentQueue.add('process', { documentId: saved.id }, {
      jobId: `doc-${saved.id}`,
    });

    this.logger.log(`Document ${saved.id} created (${saved.sequential}) and enqueued`);
    return this.formatResponse(saved);
  }

  /**
   * Create a document and process it synchronously (XML -> sign -> SRI -> authorization).
   * If processing fails, the document is enqueued for async retry.
   * Returns the final result in the same HTTP response.
   */
  async createSync(company: Company, dto: CreateDocumentDto) {
    // Reuse all the validation + creation logic
    const saved = await this.createDocumentRecord(company, dto);

    // Process inline instead of enqueuing
    let processingResult: ProcessingResult;
    try {
      processingResult = await this.processingService.processDocument(saved.id);
    } catch (err: any) {
      // Unexpected crash — enqueue for retry
      this.logger.error(`Sync processing crashed for doc ${saved.id}: ${err.message}`);

      await this.documentQueue.add('process', { documentId: saved.id }, {
        jobId: `doc-retry-${saved.id}`,
      });

      // Re-read doc to get updated status
      const updated = await this.docRepo.findOne({ where: { id: saved.id } });
      return {
        ...this.formatResponse(updated ?? saved),
        procesamiento: {
          modo: 'sync',
          resultado: 'failed',
          encolado: true,
          mensaje: 'Error inesperado durante el procesamiento. El documento fue encolado para reintento automático.',
          errores: [{ codigo: 'SYS001', mensaje: err.message }],
          tiempoProcesamiento: null,
        },
      };
    }

    // If failed (system error) — enqueue for full retry
    if (processingResult.status === 'failed') {
      await this.documentQueue.add('process', { documentId: saved.id }, {
        jobId: `doc-retry-${saved.id}`,
      });
    }

    // If processing (SRI accepted but not yet authorized) — enqueue auth-check
    if (processingResult.status === 'processing') {
      await this.documentQueue.add('auth-check', {
        documentId: saved.id,
        authCheckOnly: true,
      }, {
        jobId: `auth-check-${saved.id}-0`,
        delay: 30_000,
        attempts: 1,
      });
    }

    // Re-read doc with updated fields (auth number, status, etc.)
    const finalDoc = await this.docRepo.findOne({ where: { id: saved.id }, relations: ['company'] });

    return {
      ...this.formatResponse(finalDoc ?? saved),
      procesamiento: this.buildProcessingResponse(processingResult),
    };
  }

  /**
   * Correct an existing document and reprocess asynchronously.
   * Only allowed for documents in correctable states (CREATED, REJECTED, FAILED).
   * Identifies the document by its access key (49 digits).
   */
  async correct(company: Company, accessKey: string, dto: CreateDocumentDto) {
    const doc = await this.getCorrectableDocument(company.id, accessKey);

    await this.resetAndUpdateDocument(doc, company, dto);

    await this.documentQueue.add('process', { documentId: doc.id }, {
      jobId: `doc-${doc.id}-r${doc.retries}`,
    });

    this.logger.log(`Document ${doc.id} corrected and re-enqueued`);

    const updated = await this.docRepo.findOne({ where: { id: doc.id } });
    return this.formatResponse(updated ?? doc);
  }

  /**
   * Correct an existing document and reprocess synchronously.
   * Only allowed for documents in correctable states (CREATED, REJECTED, FAILED).
   * Identifies the document by its access key (49 digits).
   */
  async correctSync(company: Company, accessKey: string, dto: CreateDocumentDto) {
    const doc = await this.getCorrectableDocument(company.id, accessKey);

    await this.resetAndUpdateDocument(doc, company, dto);

    let processingResult: ProcessingResult;
    try {
      processingResult = await this.processingService.processDocument(doc.id);
    } catch (err: any) {
      this.logger.error(`Sync correction crashed for doc ${doc.id}: ${err.message}`);

      await this.documentQueue.add('process', { documentId: doc.id }, {
        jobId: `doc-retry-${doc.id}`,
      });

      const updated = await this.docRepo.findOne({ where: { id: doc.id } });
      return {
        ...this.formatResponse(updated ?? doc),
        procesamiento: {
          modo: 'sync',
          resultado: 'failed',
          encolado: true,
          mensaje: 'Error inesperado durante el reprocesamiento. El documento fue encolado para reintento automático.',
          errores: [{ codigo: 'SYS001', mensaje: err.message }],
          tiempoProcesamiento: null,
        },
      };
    }

    if (processingResult.status === 'failed') {
      await this.documentQueue.add('process', { documentId: doc.id }, {
        jobId: `doc-retry-${doc.id}`,
      });
    }

    if (processingResult.status === 'processing') {
      await this.documentQueue.add('auth-check', {
        documentId: doc.id,
        authCheckOnly: true,
      }, {
        jobId: `auth-check-${doc.id}-0`,
        delay: 30_000,
        attempts: 1,
      });
    }

    const finalDoc = await this.docRepo.findOne({ where: { id: doc.id }, relations: ['company'] });

    return {
      ...this.formatResponse(finalDoc ?? doc),
      procesamiento: this.buildProcessingResponse(processingResult),
    };
  }

  /**
   * List documents for a company with pagination and filters.
   */
  async findAll(
    companyId: number,
    page = 1,
    limit = 20,
    status?: DocStatus,
    from?: string,
    to?: string,
  ) {
    const qb = this.docRepo.createQueryBuilder('d')
      .leftJoinAndSelect('d.company', 'company')
      .where('d.companyId = :companyId', { companyId })
      .orderBy('d.id', 'DESC');

    if (status) {
      qb.andWhere('d.status = :status', { status });
    }
    if (from) {
      qb.andWhere('d.issueDate >= :from', { from });
    }
    if (to) {
      qb.andWhere('d.issueDate <= :to', { to });
    }

    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data: data.map((d) => this.formatResponse(d)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get document detail with timeline, errors and files.
   * Identifies the document by its access key (49 digits).
   */
  /**
   * Find a document by the idempotency key it was emitted with.
   * Returns the same shape as findOne() (estado, clave, errores, etc.).
   */
  async findByIdempotencyKey(companyId: number, key: string) {
    const doc = await this.docRepo.findOne({
      where: { idempotencyKey: key, companyId },
      relations: ['company', 'timeline', 'errors', 'files'],
    });
    if (!doc) {
      throw new NotFoundException(`No existe ningún documento con idempotencyKey "${key}" en esta empresa.`);
    }
    const tz = doc.company?.timezone ?? 'America/Guayaquil';
    return {
      ...this.formatResponse(doc),
      timeline: (doc.timeline?.sort((a, b) => a.order - b.order) ?? []).map((t) => ({
        ...t,
        timestamp: formatDateTz(t.timestamp, tz),
      })),
      errors: doc.errors ?? [],
      files: doc.files?.map((f) => ({
        id: f.id,
        type: f.type,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        createdAt: formatDateTz(f.createdAt, tz),
      })) ?? [],
    };
  }

  async findOne(companyId: number, accessKey: string) {
    const doc = await this.docRepo.findOne({
      where: { accessKey, companyId },
      relations: ['company', 'timeline', 'errors', 'files'],
    });

    if (!doc) {
      throw new NotFoundException('Documento no encontrado');
    }

    const tz = doc.company?.timezone ?? 'America/Guayaquil';
    return {
      ...this.formatResponse(doc),
      timeline: (doc.timeline?.sort((a, b) => a.order - b.order) ?? []).map((t) => ({
        ...t,
        timestamp: formatDateTz(t.timestamp, tz),
      })),
      errors: doc.errors ?? [],
      files: doc.files?.map((f) => ({
        id: f.id,
        type: f.type,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        createdAt: formatDateTz(f.createdAt, tz),
      })) ?? [],
    };
  }

  /**
   * Manually retry authorization check for a document stuck in RECEIVED state.
   * Identifies the document by its access key (49 digits).
   */
  async retryAuthorization(companyId: number, accessKey: string) {
    const doc = await this.findByAccessKey(companyId, accessKey);

    if (doc.status !== DocStatus.RECEIVED) {
      throw new ConflictException(
        `Solo se puede reintentar autorización para documentos en estado RECEIVED. ` +
        `Estado actual: ${doc.status}.`,
      );
    }

    const result = await this.processingService.retryAuthorization(doc.id);

    // If still processing, schedule background retry
    if (result.status === 'processing') {
      await this.documentQueue.add('auth-check', {
        documentId: doc.id,
        authCheckOnly: true,
      }, {
        jobId: `auth-check-manual-${doc.id}-${Date.now()}`,
        delay: 30_000,
        attempts: 1,
      });
    }

    const finalDoc = await this.docRepo.findOne({ where: { id: doc.id }, relations: ['company'] });

    return {
      ...this.formatResponse(finalDoc ?? doc),
      procesamiento: this.buildProcessingResponse(result),
    };
  }

  /**
   * Download a file (signed_xml, authorized_xml, ride) for a document identified by access key.
   */
  async downloadFile(companyId: number, accessKey: string, fileType: string, regenerate = false): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
  }> {
    const fileTypeMap: Record<string, DocFileType> = {
      signed_xml: DocFileType.SIGNED_XML,
      authorized_xml: DocFileType.AUTHORIZED_XML,
      ride: DocFileType.RIDE,
    };

    const docFileType = fileTypeMap[fileType];
    if (!docFileType) {
      throw new NotFoundException(`Tipo de archivo no válido: ${fileType}. Valores válidos: signed_xml, authorized_xml, ride`);
    }

    const doc = await this.findByAccessKey(companyId, accessKey);

    // Regenerate RIDE if requested
    if (regenerate && fileType === 'ride') {
      const pdfBuffer = await this.processingService.regenerateRide(doc.id);
      const docTypePrefix: Record<string, string> = {
        '01': 'FAC', '03': 'LIQ', '04': 'NC', '05': 'ND', '06': 'GR', '07': 'RET',
      };
      const typeLabel = docTypePrefix[doc.typeCode] || 'DOC';
      return { buffer: pdfBuffer, filename: `${typeLabel}_${doc.accessKey}.pdf`, contentType: 'application/pdf' };
    }

    const file = await this.fileRepo.findOne({
      where: { documentId: doc.id, type: docFileType },
    });

    if (!file) {
      throw new NotFoundException(`Archivo ${fileType} no encontrado para este documento. El documento puede no haber sido procesado aún.`);
    }

    const buffer = await this.s3Service.download(file.s3Key);

    const extensions: Record<string, { ext: string; mime: string }> = {
      signed_xml: { ext: 'xml', mime: 'application/xml' },
      authorized_xml: { ext: 'xml', mime: 'application/xml' },
      ride: { ext: 'pdf', mime: 'application/pdf' },
    };
    const { ext, mime } = extensions[fileType];

    const docTypePrefix: Record<string, string> = {
      '01': 'FAC', '03': 'LIQ', '04': 'NC', '05': 'ND', '06': 'GR', '07': 'RET',
    };
    const typeLabel = docTypePrefix[doc.typeCode] || 'DOC';
    const suffix = fileType === 'ride' ? '' : fileType === 'authorized_xml' ? '_AUT' : '_FIR';
    const filename = `${typeLabel}_${doc.accessKey}${suffix}.${ext}`;

    return { buffer, filename, contentType: mime };
  }

  // ── Private helpers ──

  /**
   * Shared: validate, check limits, generate sequential/accessKey, save document + initial timeline.
   */
  private async createDocumentRecord(company: Company, dto: CreateDocumentDto): Promise<Document> {
    const docType = dto.tipoDocumento as SriDocTypeCode;
    this.validateDocType(docType);
    this.validateDocTypeFields(docType, dto);

    const hasCert = await this.certRepo.findOne({
      where: { companyId: company.id, isCurrent: true },
    });
    if (!hasCert) {
      throw new BadRequestException('La empresa no tiene un certificado digital activo. Suba uno desde el panel.');
    }
    if (hasCert.expiresAt && new Date(hasCert.expiresAt) < new Date()) {
      throw new BadRequestException('El certificado digital ha expirado. Actualícelo desde el panel.');
    }

    await this.checkPlanLimits(company);
    this.checkAccountActive(company);
    await this.checkDocTypeEnabled(company.id, docType);

    const emissionPoint = dto.puntoEmision ?? '001';
    await this.checkEmissionPoint(company.id, emissionPoint);

    if (dto.idempotencyKey) {
      const existing = await this.docRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey, companyId: company.id },
      });
      if (existing) {
        throw new ConflictException({
          message: `Ya existe un documento con idempotencyKey "${dto.idempotencyKey}".`,
          documentoExistente: {
            id: existing.id,
            secuencial: existing.sequential,
            claveAcceso: existing.accessKey,
            estado: existing.status,
          },
          sugerencia: existing.status === DocStatus.REJECTED || existing.status === DocStatus.FAILED
            ? 'El documento anterior fue rechazado/fallido. Use PUT /documents/{claveAcceso} para corregir y reprocesar, o envíe con un idempotencyKey diferente.'
            : 'Si es un documento diferente, use un idempotencyKey distinto.',
        });
      }
    }

    // Duplicate detection via content hash. Solo aplica cuando el cliente NO
    // envía idempotencyKey — es un fallback para prevenir doble-POST accidental.
    // Si el cliente envía idempotencyKey, ya pasó el chequeo por key arriba y
    // asumimos que sabe lo que hace (facturas legítimas idénticas están permitidas).
    const contentHash = this.computeContentHash(dto);
    if (!dto.idempotencyKey) {
      const duplicate = await this.docRepo.findOne({
        where: { companyId: company.id, contentHash },
      });
      if (duplicate) {
        throw new ConflictException({
          message: 'Documento duplicado detectado. Ya existe un documento con el mismo contenido.',
          documentoExistente: {
            id: duplicate.id,
            secuencial: duplicate.sequential,
            claveAcceso: duplicate.accessKey,
            estado: duplicate.status,
          },
          sugerencia: 'Si se trata de dos comprobantes distintos legítimamente idénticos, envíe cada uno con un idempotencyKey único para saltar esta protección. Si desea reprocesar el existente, use PUT /documents/{claveAcceso}.',
        });
      }
    }

    // Sequential: company decides if they provide it or we generate it
    let sequential: string;
    let fullSequential: string;
    if (company.sequentialMode === SequentialMode.CLIENT) {
      if (!dto.secuencial) {
        throw new BadRequestException(
          'La empresa está configurada para enviar el secuencial (modo "client"). ' +
          'Incluya el campo "secuencial" con 9 dígitos (ej: "000000015").',
        );
      }
      if (!/^\d{1,9}$/.test(dto.secuencial)) {
        throw new BadRequestException(
          'El secuencial debe ser numérico de hasta 9 dígitos.',
        );
      }
      sequential = dto.secuencial.padStart(9, '0');
      fullSequential = `${company.establishment}-${emissionPoint}-${sequential}`;
    } else {
      if (dto.secuencial) {
        throw new BadRequestException(
          'La empresa está configurada para que la plataforma genere el secuencial (modo "platform"). ' +
          'No envíe el campo "secuencial".',
        );
      }
      ({ sequential, fullSequential } = await this.sequentialService.nextSequential(
        company.id, docType, company.establishment, emissionPoint,
      ));
    }
    // For guía de remisión (06), the SRI validates the claveAcceso date against
    // fechaIniTransporte (the "emission date" in the GR XSD), not fechaEmision.
    const issueDateStr = docType === SriDocTypeCode.GUIA_REMISION && dto.fechaIniTransporte
      ? dto.fechaIniTransporte
      : dto.fechaEmision;
    const issueDate = this.parseDate(issueDateStr);

    // Access key: company decides if they provide it or we generate it
    let accessKey: string;
    if (company.accessKeyMode === AccessKeyMode.CLIENT) {
      if (!dto.claveAcceso) {
        throw new BadRequestException(
          'La empresa está configurada para enviar la clave de acceso (modo "client"). ' +
          'Incluya el campo "claveAcceso" con los 49 dígitos.',
        );
      }
      this.validateAccessKey(dto.claveAcceso);
      accessKey = dto.claveAcceso;
    } else {
      if (dto.claveAcceso) {
        throw new BadRequestException(
          'La empresa está configurada para que la plataforma genere la clave de acceso (modo "platform"). ' +
          'No envíe el campo "claveAcceso".',
        );
      }
      accessKey = this.accessKeyService.generate({
        issueDate, docType, ruc: company.ruc, env: company.env,
        establishment: company.establishment, emissionPoint, sequential,
      });
    }

    const doc = new Document();
    doc.companyId = company.id;
    doc.typeCode = docType;
    doc.sequential = fullSequential;
    doc.accessKey = accessKey;
    doc.status = DocStatus.CREATED;
    doc.env = company.env;
    doc.issueDate = issueDate;

    if (docType === SriDocTypeCode.RETENCION) {
      const totalRetenido = (dto.impuestosRetencion || []).reduce((s, i) => s + i.valorRetenido, 0);
      doc.totalAmount = totalRetenido;
      doc.subtotal = (dto.impuestosRetencion || []).reduce((s, i) => s + i.baseImponible, 0);
      doc.totalTax = totalRetenido;
      doc.totalDiscount = 0;
    } else if (docType === SriDocTypeCode.NOTA_CREDITO) {
      doc.totalAmount = dto.valorModificacion!;
      doc.subtotal = dto.totalSinImpuestos!;
      doc.totalTax = dto.totalConImpuestos!.reduce((s, t) => s + t.valor, 0);
      doc.totalDiscount = dto.totalDescuento ?? 0;
    } else if (docType === SriDocTypeCode.NOTA_DEBITO) {
      doc.totalAmount = dto.valorTotal!;
      doc.subtotal = dto.totalSinImpuestos!;
      doc.totalTax = dto.totalConImpuestos!.reduce((s, t) => s + t.valor, 0);
      doc.totalDiscount = 0;
    } else if (docType === SriDocTypeCode.GUIA_REMISION) {
      doc.totalAmount = 0;
      doc.subtotal = 0;
      doc.totalTax = 0;
      doc.totalDiscount = 0;
    } else {
      doc.totalAmount = dto.importeTotal!;
      doc.subtotal = dto.totalSinImpuestos!;
      doc.totalTax = dto.totalConImpuestos!.reduce((s, t) => s + t.valor, 0);
      doc.totalDiscount = dto.totalDescuento!;
    }
    doc.buyerName = dto.razonSocialComprador;
    doc.buyerIdType = dto.tipoIdentificacionComprador;
    doc.buyerId = dto.identificacionComprador;
    doc.establishment = company.establishment;
    doc.emissionPoint = emissionPoint;
    doc.contentHash = contentHash;
    doc.idempotencyKey = dto.idempotencyKey as any;
    doc.payload = dto as any;

    const saved = await this.docRepo.save(doc);

    await this.timelineRepo.save({
      documentId: saved.id,
      step: 'received',
      status: TimelineStepStatus.COMPLETED,
      order: 0,
      description: 'Documento recibido',
      timestamp: new Date(),
    });

    return saved;
  }

  /**
   * Fetch a document by access key and validate it belongs to the company.
   */
  private async findByAccessKey(companyId: number, accessKey: string): Promise<Document> {
    const doc = await this.docRepo.findOne({
      where: { accessKey, companyId },
    });

    if (!doc) {
      throw new NotFoundException('Documento no encontrado');
    }

    return doc;
  }

  /**
   * Fetch a document by access key and validate it is in a correctable state.
   */
  private async getCorrectableDocument(companyId: number, accessKey: string): Promise<Document> {
    const doc = await this.findByAccessKey(companyId, accessKey);

    if (!CORRECTABLE_STATES.includes(doc.status)) {
      throw new ConflictException(
        `No se puede corregir un documento en estado "${doc.status}". ` +
        `Solo se pueden corregir documentos en estado: ${CORRECTABLE_STATES.join(', ')}.`,
      );
    }

    return doc;
  }

  /**
   * Reset a document to CREATED state: clear old timeline/errors/files, update payload and totals.
   * Regenerates the access key if the document was already sent to SRI (REJECTED/FAILED),
   * because the old key is "burned" and will trigger error 70 at reception.
   */
  private async resetAndUpdateDocument(doc: Document, company: Company, dto: CreateDocumentDto): Promise<void> {
    // Clean old processing artifacts
    await this.timelineRepo.delete({ documentId: doc.id });
    await this.errorRepo.delete({ documentId: doc.id });
    // Keep files from previous attempts? No — they're from rejected/failed XMLs
    await this.fileRepo.delete({ documentId: doc.id });

    // Regenerate access key if doc was previously sent to SRI (key is burned)
    const wasSentToSri = doc.status === DocStatus.REJECTED || doc.status === DocStatus.FAILED;
    if (wasSentToSri && company.accessKeyMode !== AccessKeyMode.CLIENT) {
      const parts = doc.sequential.split('-');
      const establishment = parts[0] ?? company.establishment;
      const emissionPoint = parts[1] ?? doc.emissionPoint;
      const sequential = parts[2] ?? doc.sequential;
      const resetDateStr = doc.typeCode === SriDocTypeCode.GUIA_REMISION && dto.fechaIniTransporte
        ? dto.fechaIniTransporte
        : dto.fechaEmision;
      doc.accessKey = this.accessKeyService.generate({
        issueDate: this.parseDate(resetDateStr),
        docType: doc.typeCode,
        ruc: company.ruc,
        env: company.env,
        establishment,
        emissionPoint,
        sequential,
      });
    }

    // Update payload and recalculated fields
    doc.payload = dto as any;
    doc.status = DocStatus.CREATED;
    if (doc.typeCode === SriDocTypeCode.RETENCION) {
      const totalRetenido = (dto.impuestosRetencion || []).reduce((s, i) => s + i.valorRetenido, 0);
      doc.totalAmount = totalRetenido;
      doc.subtotal = (dto.impuestosRetencion || []).reduce((s, i) => s + i.baseImponible, 0);
      doc.totalTax = totalRetenido;
      doc.totalDiscount = 0;
    } else if (doc.typeCode === SriDocTypeCode.NOTA_CREDITO) {
      doc.totalAmount = dto.valorModificacion!;
      doc.subtotal = dto.totalSinImpuestos!;
      doc.totalTax = dto.totalConImpuestos!.reduce((s, t) => s + t.valor, 0);
      doc.totalDiscount = dto.totalDescuento ?? 0;
    } else if (doc.typeCode === SriDocTypeCode.NOTA_DEBITO) {
      doc.totalAmount = dto.valorTotal!;
      doc.subtotal = dto.totalSinImpuestos!;
      doc.totalTax = dto.totalConImpuestos!.reduce((s, t) => s + t.valor, 0);
      doc.totalDiscount = 0;
    } else if (doc.typeCode === SriDocTypeCode.GUIA_REMISION) {
      doc.totalAmount = 0;
      doc.subtotal = 0;
      doc.totalTax = 0;
      doc.totalDiscount = 0;
    } else {
      doc.totalAmount = dto.importeTotal!;
      doc.subtotal = dto.totalSinImpuestos!;
      doc.totalTax = dto.totalConImpuestos!.reduce((s, t) => s + t.valor, 0);
      doc.totalDiscount = dto.totalDescuento!;
    }
    doc.buyerName = dto.razonSocialComprador;
    doc.buyerIdType = dto.tipoIdentificacionComprador;
    doc.buyerId = dto.identificacionComprador;
    doc.contentHash = this.computeContentHash(dto);
    doc.authNumber = null as any;
    doc.authAt = null as any;
    doc.processingTimeMs = null as any;

    await this.docRepo.save(doc);

    // Add fresh timeline entry
    await this.timelineRepo.save({
      documentId: doc.id,
      step: 'received',
      status: TimelineStepStatus.COMPLETED,
      order: 0,
      description: 'Documento corregido y reenviado',
      timestamp: new Date(),
    });
  }

  private validateDocType(code: string) {
    const valid = ['01', '03', '04', '05', '06', '07'];
    if (!valid.includes(code)) {
      throw new BadRequestException(`Tipo de documento inválido: ${code}. Valores válidos: ${valid.join(', ')}`);
    }
  }

  private validateDocTypeFields(docType: SriDocTypeCode, dto: CreateDocumentDto) {
    if (docType === SriDocTypeCode.RETENCION) {
      // Retención requires: periodoFiscal, impuestosRetencion
      if (!dto.periodoFiscal) {
        throw new BadRequestException('periodoFiscal es requerido para retenciones (formato MM/AAAA).');
      }
      if (!dto.impuestosRetencion || dto.impuestosRetencion.length === 0) {
        throw new BadRequestException('impuestosRetencion es requerido para retenciones (al menos 1 impuesto).');
      }
    } else if (docType === SriDocTypeCode.NOTA_CREDITO) {
      // NC requires: codDocModificado, numDocModificado, fechaEmisionDocSustento, motivo + detalles/totals
      const missing: string[] = [];
      if (!dto.codDocModificado) missing.push('codDocModificado');
      if (!dto.numDocModificado) missing.push('numDocModificado');
      if (!dto.fechaEmisionDocSustento) missing.push('fechaEmisionDocSustento');
      if (!dto.motivo) missing.push('motivo');
      if (dto.totalSinImpuestos == null) missing.push('totalSinImpuestos');
      if (!dto.totalConImpuestos || dto.totalConImpuestos.length === 0) missing.push('totalConImpuestos');
      if (dto.valorModificacion == null) missing.push('valorModificacion');
      if (!dto.detalles || dto.detalles.length === 0) missing.push('detalles');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Campos requeridos para nota de crédito (04): ${missing.join(', ')}.`,
        );
      }
    } else if (docType === SriDocTypeCode.NOTA_DEBITO) {
      // ND requires: codDocModificado, numDocModificado, fechaEmisionDocSustento, motivos, totalSinImpuestos, totalConImpuestos, valorTotal
      const missing: string[] = [];
      if (!dto.codDocModificado) missing.push('codDocModificado');
      if (!dto.numDocModificado) missing.push('numDocModificado');
      if (!dto.fechaEmisionDocSustento) missing.push('fechaEmisionDocSustento');
      if (!dto.motivos || dto.motivos.length === 0) missing.push('motivos');
      if (dto.totalSinImpuestos == null) missing.push('totalSinImpuestos');
      if (!dto.totalConImpuestos || dto.totalConImpuestos.length === 0) missing.push('totalConImpuestos');
      if (dto.valorTotal == null) missing.push('valorTotal');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Campos requeridos para nota de débito (05): ${missing.join(', ')}.`,
        );
      }
    } else if (docType === SriDocTypeCode.GUIA_REMISION) {
      // GR requires: dirPartida, transportista info, fechas transporte, placa, destinatarios
      const missing: string[] = [];
      if (!dto.dirPartida) missing.push('dirPartida');
      if (!dto.razonSocialTransportista) missing.push('razonSocialTransportista');
      if (!dto.tipoIdentificacionTransportista) missing.push('tipoIdentificacionTransportista');
      if (!dto.rucTransportista) missing.push('rucTransportista');
      if (!dto.fechaIniTransporte) missing.push('fechaIniTransporte');
      if (!dto.fechaFinTransporte) missing.push('fechaFinTransporte');
      if (!dto.placa) missing.push('placa');
      if (!dto.destinatarios || dto.destinatarios.length === 0) missing.push('destinatarios');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Campos requeridos para guía de remisión (06): ${missing.join(', ')}.`,
        );
      }
    } else {
      // Factura-type documents require: detalles, pagos, totals
      const missing: string[] = [];
      if (dto.totalSinImpuestos == null) missing.push('totalSinImpuestos');
      if (dto.totalDescuento == null) missing.push('totalDescuento');
      if (!dto.totalConImpuestos || dto.totalConImpuestos.length === 0) missing.push('totalConImpuestos');
      if (dto.importeTotal == null) missing.push('importeTotal');
      if (!dto.pagos || dto.pagos.length === 0) missing.push('pagos');
      if (!dto.detalles || dto.detalles.length === 0) missing.push('detalles');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Campos requeridos para ${docType}: ${missing.join(', ')}.`,
        );
      }
    }
  }

  /** Free test documents per month for all plans (after trial) */
  static readonly TEST_DOC_LIMIT = 50;

  private async checkPlanLimits(company: Company) {
    if (!company.plan) return;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const isTestEnv = company.env === 'test';

    if (isTestEnv) {
      // Test environment: 50 free docs/month for all plans
      const testCount = await this.docRepo
        .createQueryBuilder('d')
        .where('d.companyId = :companyId', { companyId: company.id })
        .andWhere('d.createdAt >= :start', { start: startOfMonth })
        .andWhere('d.createdAt < :end', { end: endOfMonth })
        .andWhere('d.env = :env', { env: 'test' })
        .getCount();

      if (testCount >= PublicDocumentsService.TEST_DOC_LIMIT) {
        throw new ForbiddenException(
          `Límite de documentos de prueba alcanzado (${PublicDocumentsService.TEST_DOC_LIMIT}/mes). ` +
          `Los documentos en ambiente de pruebas tienen un límite de ${PublicDocumentsService.TEST_DOC_LIMIT} por mes.`,
        );
      }
      return; // Test docs don't consume plan limit
    }

    // Production environment: check plan limit
    const plan = company.plan;
    if (!plan.docLimit) return; // Unlimited or no limit

    const prodCount = await this.docRepo
      .createQueryBuilder('d')
      .where('d.companyId = :companyId', { companyId: company.id })
      .andWhere('d.createdAt >= :start', { start: startOfMonth })
      .andWhere('d.createdAt < :end', { end: endOfMonth })
      .andWhere('d.env = :env', { env: 'production' })
      .getCount();

    // Notification 4: limit reached (send once when exactly at limit)
    if (prodCount === plan.docLimit) {
      this.notificationService.sendLimitReached({
        companyName: company.name,
        companyRuc: company.ruc,
        companyEmail: company.email,
        notificationEmail: company.notificationEmail,
        docLimit: plan.docLimit,
        docsUsed: prodCount,
        overageEnabled: company.overageEnabled,
      }).catch(() => {});
    }

    if (prodCount >= plan.docLimit && !company.overageEnabled) {
      throw new ForbiddenException(
        `Límite de documentos alcanzado (${plan.docLimit}/mes). ` +
        `Contacte al administrador para habilitar excedentes o cambiar de plan.`,
      );
    }
  }

  private checkAccountActive(company: Company) {
    if (!company.account) return;
    if (!company.account.isActive) {
      throw new ForbiddenException(
        'La cuenta está desactivada. Contacte al administrador de la plataforma.',
      );
    }
  }

  private async checkDocTypeEnabled(companyId: number, docType: SriDocTypeCode) {
    const enabledTypes = await this.docTypeRepo.find({ where: { companyId } });
    // If no doc types configured, allow all (backwards compatible)
    if (enabledTypes.length === 0) return;

    const allowed = enabledTypes.some((dt) => dt.code === docType);
    if (!allowed) {
      const enabledCodes = enabledTypes.map((dt) => dt.code).join(', ');
      throw new ForbiddenException(
        `La empresa no tiene habilitado el tipo de documento "${docType}". ` +
        `Tipos habilitados: ${enabledCodes}. Contacte al administrador.`,
      );
    }
  }

  private async checkEmissionPoint(companyId: number, code: string) {
    const ep = await this.emissionPointRepo.findOne({
      where: { companyId, code },
    });

    if (!ep) {
      throw new BadRequestException(
        `El punto de emisión "${code}" no existe para esta empresa. Verifique la configuración.`,
      );
    }

    if (!ep.isActive) {
      throw new BadRequestException(
        `El punto de emisión "${code}" está desactivado. Contacte al administrador.`,
      );
    }
  }

  private parseDate(dateStr: string): Date {
    // DD/MM/AAAA → Date
    const parts = dateStr.split('/');
    if (parts.length !== 3) {
      throw new BadRequestException('Formato de fecha inválido. Use DD/MM/AAAA');
    }
    const [dd, mm, yyyy] = parts;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }

  /**
   * Compute SHA-256 hash of the key business fields to detect duplicates.
   * Hash = SHA256(tipoDocumento | fechaEmision | identificacionComprador | importeTotal | detalles_count)
   */
  private computeContentHash(dto: CreateDocumentDto): string {
    const parts: string[] = [
      dto.tipoDocumento,
      dto.fechaEmision,
      dto.identificacionComprador,
      dto.secuencial ?? '',
      dto.claveAcceso ?? '',
    ];

    if (dto.tipoDocumento === SriDocTypeCode.RETENCION) {
      parts.push(dto.periodoFiscal ?? '');
      parts.push(String(dto.impuestosRetencion?.length ?? 0));
      parts.push(
        (dto.impuestosRetencion || [])
          .map((i) => `${i.codDocSustento}:${i.numDocSustento}:${i.codigoRetencion}:${i.valorRetenido}`)
          .join('|'),
      );
    } else if (dto.tipoDocumento === SriDocTypeCode.NOTA_CREDITO) {
      parts.push(dto.codDocModificado ?? '');
      parts.push(dto.numDocModificado ?? '');
      parts.push(dto.motivo ?? '');
      parts.push(String(dto.valorModificacion ?? 0));
      parts.push(String(dto.totalSinImpuestos ?? 0));
      const detalles = dto.detalles || [];
      parts.push(String(detalles.length));
      parts.push(
        detalles.map((d) => `${d.codigoPrincipal}:${d.cantidad}:${d.precioTotalSinImpuesto}`).join('|'),
      );
    } else if (dto.tipoDocumento === SriDocTypeCode.NOTA_DEBITO) {
      parts.push(dto.codDocModificado ?? '');
      parts.push(dto.numDocModificado ?? '');
      parts.push(String(dto.valorTotal ?? 0));
      parts.push(String(dto.totalSinImpuestos ?? 0));
      const motivos = dto.motivos || [];
      parts.push(String(motivos.length));
      parts.push(
        motivos.map((m) => `${m.razon}:${m.valor}`).join('|'),
      );
    } else if (dto.tipoDocumento === SriDocTypeCode.GUIA_REMISION) {
      parts.push(dto.dirPartida ?? '');
      parts.push(dto.rucTransportista ?? '');
      parts.push(dto.placa ?? '');
      parts.push(dto.fechaIniTransporte ?? '');
      parts.push(dto.fechaFinTransporte ?? '');
      const destinatarios = dto.destinatarios || [];
      parts.push(String(destinatarios.length));
      parts.push(
        destinatarios.map((d) => `${d.identificacionDestinatario}:${d.motivoTraslado}:${d.detalles.length}`).join('|'),
      );
    } else {
      parts.push(String(dto.importeTotal ?? 0));
      parts.push(String(dto.totalSinImpuestos ?? 0));
      const detalles = dto.detalles || [];
      parts.push(String(detalles.length));
      parts.push(detalles[0]?.codigoPrincipal ?? '');
      parts.push(detalles[detalles.length - 1]?.codigoPrincipal ?? '');
      parts.push(
        detalles.map((d) => `${d.codigoPrincipal}:${d.cantidad}:${d.precioTotalSinImpuesto}`).join('|'),
      );
    }

    return createHash('sha256').update(parts.join('::')).digest('hex');
  }

  /**
   * Validate a client-provided access key (49 numeric digits).
   */
  private validateAccessKey(key: string): void {
    if (!/^\d{49}$/.test(key)) {
      throw new BadRequestException(
        'La clave de acceso debe tener exactamente 49 dígitos numéricos.',
      );
    }
  }

  private buildProcessingResponse(result: ProcessingResult) {
    const messages: Record<ProcessingResult['status'], string> = {
      authorized: 'Documento autorizado exitosamente por el SRI.',
      rejected: 'El SRI rechazó el documento. Revise los errores.',
      failed: 'Error durante el procesamiento. El documento fue encolado para reintento automático.',
      processing: 'El SRI recibió el documento pero aún no lo ha autorizado. Se reintentará automáticamente. Consulte el estado con GET /documents/{claveAcceso}.',
    };

    return {
      modo: 'sync',
      resultado: result.status,
      encolado: result.status === 'failed' || result.status === 'processing',
      mensaje: messages[result.status],
      numeroAutorizacion: result.authorizationNumber ?? null,
      fechaAutorizacion: formatDateTz(result.authorizedAt) ?? null,
      errores: result.errors.map((e) => ({
        codigo: e.code,
        mensaje: e.message,
        detalle: e.detail ?? null,
      })),
      tiempoProcesamiento: result.processingTimeMs,
    };
  }

  private formatResponse(doc: Document) {
    const tz = doc.company?.timezone ?? 'America/Guayaquil';
    return {
      id: doc.id,
      tipoDocumento: doc.typeCode,
      secuencial: doc.sequential,
      claveAcceso: doc.accessKey,
      estado: doc.status,
      ambiente: doc.env,
      fechaEmision: doc.issueDate,
      numeroAutorizacion: doc.authNumber,
      fechaAutorizacion: formatDateTz(doc.authAt, tz),
      recibidoEn: formatDateTz(doc.receivedAt, tz),
      importeTotal: Number(doc.totalAmount),
      subtotal: Number(doc.subtotal),
      totalImpuestos: Number(doc.totalTax),
      totalDescuento: Number(doc.totalDiscount),
      comprador: {
        nombre: doc.buyerName,
        tipoIdentificacion: doc.buyerIdType,
        identificacion: doc.buyerId,
      },
      establecimiento: doc.establishment,
      puntoEmision: doc.emissionPoint,
      creadoEn: formatDateTz(doc.createdAt, tz),
      tiempoProcesamiento: doc.processingTimeMs ? `${(doc.processingTimeMs / 1000).toFixed(1)}s` : null,
    };
  }
}
