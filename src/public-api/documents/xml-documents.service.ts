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
import { DocStatus, SriDocTypeCode, TimelineStepStatus } from '../../entities/enums';
import { DocumentProcessingService, ProcessingResult } from '../../engine/processing/document-processing.service';
import { XmlParserService, ParsedXmlMetadata } from '../../engine/xml/xml-parser.service';
import { CreateXmlDocumentDto } from './dto/create-xml-document.dto';
import { DOCUMENT_QUEUE } from '../../queues/queues.constants';
import { formatDateTz } from '../../common/utils/date.util';
import { NotificationService } from '../../notifications/notification.service';

const CORRECTABLE_STATES: DocStatus[] = [DocStatus.CREATED, DocStatus.REJECTED, DocStatus.FAILED];

@Injectable()
export class XmlDocumentsService {
  private readonly logger = new Logger(XmlDocumentsService.name);

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
    private readonly processingService: DocumentProcessingService,
    private readonly xmlParserService: XmlParserService,
    private readonly notificationService: NotificationService,
  ) {}

  // ── Create (async) ──

  async create(company: Company, dto: CreateXmlDocumentDto) {
    const saved = await this.createDocumentRecord(company, dto);

    await this.documentQueue.add('process', { documentId: saved.id }, {
      jobId: `doc-${saved.id}`,
    });

    this.logger.log(`XML Document ${saved.id} (${saved.sequential}) created and enqueued`);
    return this.formatResponse(saved);
  }

  // ── Create (sync) ──

  async createSync(company: Company, dto: CreateXmlDocumentDto) {
    const saved = await this.createDocumentRecord(company, dto);

    let processingResult: ProcessingResult;
    try {
      processingResult = await this.processingService.processDocument(saved.id);
    } catch (err: any) {
      this.logger.error(`Sync XML processing crashed for doc ${saved.id}: ${err.message}`);

      await this.documentQueue.add('process', { documentId: saved.id }, {
        jobId: `doc-retry-${saved.id}`,
      });

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

    if (processingResult.status === 'failed') {
      await this.documentQueue.add('process', { documentId: saved.id }, {
        jobId: `doc-retry-${saved.id}`,
      });
    }

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

    const finalDoc = await this.docRepo.findOne({ where: { id: saved.id }, relations: ['company'] });

    return {
      ...this.formatResponse(finalDoc ?? saved),
      procesamiento: this.buildProcessingResponse(processingResult),
    };
  }

  // ── Correct (async) ──

  async correct(company: Company, accessKey: string, dto: CreateXmlDocumentDto) {
    const doc = await this.getCorrectableDocument(company.id, accessKey);

    await this.resetAndUpdateDocument(doc, company, dto);

    await this.documentQueue.add('process', { documentId: doc.id }, {
      jobId: `doc-${doc.id}-r${doc.retries}`,
    });

    this.logger.log(`XML Document ${doc.id} corrected and re-enqueued`);

    const updated = await this.docRepo.findOne({ where: { id: doc.id } });
    return this.formatResponse(updated ?? doc);
  }

  // ── Correct (sync) ──

  async correctSync(company: Company, accessKey: string, dto: CreateXmlDocumentDto) {
    const doc = await this.getCorrectableDocument(company.id, accessKey);

    await this.resetAndUpdateDocument(doc, company, dto);

    let processingResult: ProcessingResult;
    try {
      processingResult = await this.processingService.processDocument(doc.id);
    } catch (err: any) {
      this.logger.error(`Sync XML correction crashed for doc ${doc.id}: ${err.message}`);

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

  // ── Private helpers ──

  private async createDocumentRecord(company: Company, dto: CreateXmlDocumentDto): Promise<Document> {
    const meta = this.xmlParserService.parse(dto.xml);

    this.validateCompanyOwnership(company, meta);
    await this.validatePrerequisites(company, meta.codDoc as SriDocTypeCode);

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

    // Duplicate detection via content hash of the XML. Solo aplica cuando el
    // cliente NO envía idempotencyKey — es fallback contra doble-POST accidental.
    // Con idempotencyKey explícito guardamos contentHash NULL para no colisionar
    // con el índice único parcial uq_document_content_hash (dos XMLs idénticos
    // legítimos están permitidos siempre y cuando usen keys distintas).
    const contentHash = dto.idempotencyKey ? null : this.computeContentHash(dto.xml);
    if (contentHash) {
      const duplicate = await this.docRepo.findOne({
        where: { companyId: company.id, contentHash },
      });
      if (duplicate) {
        throw new ConflictException({
          message: 'Documento duplicado detectado. Ya existe un documento con el mismo XML.',
          documentoExistente: {
            id: duplicate.id,
            secuencial: duplicate.sequential,
            claveAcceso: duplicate.accessKey,
            estado: duplicate.status,
          },
          sugerencia: 'Si son dos comprobantes legítimos con el mismo contenido, envíe cada uno con un idempotencyKey único. Si desea reprocesar el existente, use PUT /documents/xml/{claveAcceso}.',
        });
      }
    }

    const issueDate = this.parseDate(meta.fechaEmision);

    const doc = new Document();
    doc.companyId = company.id;
    doc.typeCode = meta.codDoc as SriDocTypeCode;
    doc.sequential = meta.secuencial;
    doc.accessKey = meta.claveAcceso;
    doc.status = DocStatus.CREATED;
    doc.env = company.env;
    doc.issueDate = issueDate;
    doc.totalAmount = meta.importeTotal;
    doc.subtotal = meta.totalSinImpuestos;
    doc.totalTax = meta.totalImpuestos;
    doc.totalDiscount = meta.totalDescuento;
    doc.buyerName = meta.buyerName;
    doc.buyerIdType = meta.buyerIdType;
    doc.buyerId = meta.buyerId;
    doc.establishment = meta.establecimiento;
    doc.emissionPoint = meta.puntoEmision;
    doc.contentHash = contentHash as any;
    doc.idempotencyKey = dto.idempotencyKey as any;
    // Store raw XML and email in payload for processing
    doc.payload = { _rawXml: dto.xml, emailComprador: dto.emailComprador } as any;

    const saved = await this.docRepo.save(doc);

    await this.timelineRepo.save({
      documentId: saved.id,
      step: 'received',
      status: TimelineStepStatus.COMPLETED,
      order: 0,
      description: 'Documento XML recibido',
      timestamp: new Date(),
    });

    return saved;
  }

  /**
   * Validate that the XML belongs to this company (RUC match, environment match).
   */
  private validateCompanyOwnership(company: Company, meta: ParsedXmlMetadata) {
    if (meta.ruc !== company.ruc) {
      throw new BadRequestException(
        `El RUC del XML (${meta.ruc}) no coincide con el RUC de la empresa (${company.ruc}).`,
      );
    }

    const expectedAmbiente = company.env === 'production' ? '2' : '1';
    if (meta.ambiente && meta.ambiente !== expectedAmbiente) {
      throw new BadRequestException(
        `El ambiente del XML (${meta.ambiente}) no coincide con el ambiente configurado (${expectedAmbiente}).`,
      );
    }
  }

  private async validatePrerequisites(company: Company, docType: SriDocTypeCode) {
    // Certificate
    const hasCert = await this.certRepo.findOne({
      where: { companyId: company.id, isCurrent: true },
    });
    if (!hasCert) {
      throw new BadRequestException('La empresa no tiene un certificado digital activo.');
    }
    if (hasCert.expiresAt && new Date(hasCert.expiresAt) < new Date()) {
      throw new BadRequestException('El certificado digital ha expirado.');
    }

    // Plan limits
    await this.checkPlanLimits(company);

    // Account active
    if (company.account && !company.account.isActive) {
      throw new ForbiddenException('La cuenta está desactivada.');
    }

    // Doc type enabled
    const enabledTypes = await this.docTypeRepo.find({ where: { companyId: company.id } });
    if (enabledTypes.length > 0) {
      const allowed = enabledTypes.some((dt) => dt.code === docType);
      if (!allowed) {
        throw new ForbiddenException(
          `La empresa no tiene habilitado el tipo de documento "${docType}".`,
        );
      }
    }

    // Emission point (from XML metadata parsed earlier)
    // We skip emission point check for XML mode — the XML already contains the point
  }

  private async checkPlanLimits(company: Company) {
    if (!company.plan) return;
    const plan = company.plan;
    if (!plan.docLimit) return;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const monthCount = await this.docRepo
      .createQueryBuilder('d')
      .where('d.companyId = :companyId', { companyId: company.id })
      .andWhere('d.createdAt >= :start', { start: startOfMonth })
      .andWhere('d.createdAt < :end', { end: endOfMonth })
      .getCount();

    if (monthCount === plan.docLimit) {
      this.notificationService.sendLimitReached({
        companyName: company.name,
        companyRuc: company.ruc,
        companyEmail: company.email,
        notificationEmail: company.notificationEmail,
        docLimit: plan.docLimit,
        docsUsed: monthCount,
        overageEnabled: company.overageEnabled,
      }).catch(() => {});
    }

    if (monthCount >= plan.docLimit && !company.overageEnabled) {
      throw new ForbiddenException(
        `Límite de documentos alcanzado (${plan.docLimit}/mes).`,
      );
    }
  }

  private async getCorrectableDocument(companyId: number, accessKey: string): Promise<Document> {
    const doc = await this.docRepo.findOne({
      where: { accessKey, companyId },
    });

    if (!doc) {
      throw new NotFoundException('Documento no encontrado');
    }

    if (!CORRECTABLE_STATES.includes(doc.status)) {
      throw new ConflictException(
        `No se puede corregir un documento en estado "${doc.status}". ` +
        `Solo se pueden corregir documentos en estado: ${CORRECTABLE_STATES.join(', ')}.`,
      );
    }

    return doc;
  }

  private async resetAndUpdateDocument(doc: Document, company: Company, dto: CreateXmlDocumentDto): Promise<void> {
    const meta = this.xmlParserService.parse(dto.xml);
    this.validateCompanyOwnership(company, meta);

    await this.timelineRepo.delete({ documentId: doc.id });
    await this.errorRepo.delete({ documentId: doc.id });
    await this.fileRepo.delete({ documentId: doc.id });

    doc.payload = { _rawXml: dto.xml, emailComprador: dto.emailComprador } as any;
    doc.status = DocStatus.CREATED;
    doc.accessKey = meta.claveAcceso;
    doc.typeCode = meta.codDoc as SriDocTypeCode;
    doc.sequential = meta.secuencial;
    doc.totalAmount = meta.importeTotal;
    doc.subtotal = meta.totalSinImpuestos;
    doc.totalTax = meta.totalImpuestos;
    doc.totalDiscount = meta.totalDescuento;
    doc.buyerName = meta.buyerName;
    doc.buyerIdType = meta.buyerIdType;
    doc.buyerId = meta.buyerId;
    doc.contentHash = doc.idempotencyKey ? (null as any) : this.computeContentHash(dto.xml);
    doc.authNumber = null as any;
    doc.authAt = null as any;
    doc.processingTimeMs = null as any;

    await this.docRepo.save(doc);

    await this.timelineRepo.save({
      documentId: doc.id,
      step: 'received',
      status: TimelineStepStatus.COMPLETED,
      order: 0,
      description: 'Documento XML corregido y reenviado',
      timestamp: new Date(),
    });
  }

  private parseDate(dateStr: string): Date {
    const parts = dateStr.split('/');
    if (parts.length !== 3) {
      throw new BadRequestException('Formato de fechaEmision en XML inválido. Se espera DD/MM/AAAA.');
    }
    const [dd, mm, yyyy] = parts;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }

  private computeContentHash(xml: string): string {
    return createHash('sha256').update(xml).digest('hex');
  }

  private buildProcessingResponse(result: ProcessingResult) {
    const messages: Record<ProcessingResult['status'], string> = {
      authorized: 'Documento autorizado exitosamente por el SRI.',
      rejected: 'El SRI rechazó el documento. Revise los errores.',
      failed: 'Error durante el procesamiento. El documento fue encolado para reintento automático.',
      processing: 'El SRI recibió el documento pero aún no lo ha autorizado. Se reintentará automáticamente.',
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
      modoIngreso: 'xml',
      creadoEn: formatDateTz(doc.createdAt, tz),
      tiempoProcesamiento: doc.processingTimeMs ? `${(doc.processingTimeMs / 1000).toFixed(1)}s` : null,
    };
  }
}
