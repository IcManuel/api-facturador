import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../entities/company.entity';
import { Document } from '../entities/document.entity';
import { DocumentTimeline } from '../entities/document-timeline.entity';
import { DocumentError } from '../entities/document-error.entity';
import { DocumentFile } from '../entities/document-file.entity';
import { Certificate } from '../entities/certificate.entity';
import { EmissionPoint } from '../entities/emission-point.entity';
import { CompanyDocType } from '../entities/company-doc-type.entity';
import { CompanySeries } from '../entities/company-series.entity';
import { Account } from '../entities/account.entity';
import { EngineModule } from '../engine/engine.module';
import { QueuesModule } from '../queues/queues.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CertificatesModule } from '../admin/certificates/certificates.module';
import { PublicDocumentsController } from './documents/documents.controller';
import { PublicDocumentsService } from './documents/documents.service';
import { XmlDocumentsController } from './documents/xml-documents.controller';
import { XmlDocumentsService } from './documents/xml-documents.service';
import { InfoController } from './info/info.controller';
import { InfoService } from './info/info.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Company, Document, DocumentTimeline, DocumentError, DocumentFile, Certificate, EmissionPoint, CompanyDocType, CompanySeries, Account]),
    EngineModule,
    QueuesModule,
    NotificationsModule,
    CertificatesModule,
  ],
  controllers: [PublicDocumentsController, XmlDocumentsController, InfoController],
  providers: [PublicDocumentsService, XmlDocumentsService, InfoService],
})
export class PublicApiModule {}
