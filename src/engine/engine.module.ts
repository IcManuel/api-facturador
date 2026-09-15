import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { SequentialService } from './sequential/sequential.service';
import { AccessKeyService } from './sequential/access-key.service';
import { XmlService } from './xml/xml.service';
import { XmlParserService } from './xml/xml-parser.service';
import { SigningService } from './signing/signing.service';
import { SriService } from './sri/sri.service';
import { S3StorageService } from './storage/s3.service';
import { RideService } from './ride/ride.service';
import { DocumentProcessingService } from './processing/document-processing.service';
import { StaleDocumentCron } from './processing/stale-document.cron';
import { DocumentStatusNotifier } from './processing/document-status-notifier';
import { CryptoService } from '../common/services/crypto.service';
import { MailService } from '../common/services/mail.service';
import { RedisLockService } from '../common/services/redis-lock.service';
import { Document } from '../entities/document.entity';
import { DocumentTimeline } from '../entities/document-timeline.entity';
import { DocumentError } from '../entities/document-error.entity';
import { DocumentFile } from '../entities/document-file.entity';
import { Certificate } from '../entities/certificate.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Document, DocumentTimeline, DocumentError, DocumentFile, Certificate]),
    NotificationsModule,
  ],
  providers: [
    SequentialService,
    AccessKeyService,
    XmlService,
    XmlParserService,
    SigningService,
    SriService,
    S3StorageService,
    RideService,
    DocumentProcessingService,
    DocumentStatusNotifier,
    StaleDocumentCron,
    CryptoService,
    MailService,
    RedisLockService,
  ],
  exports: [
    SequentialService,
    AccessKeyService,
    XmlService,
    XmlParserService,
    SigningService,
    SriService,
    S3StorageService,
    RideService,
    DocumentProcessingService,
    DocumentStatusNotifier,
  ],
})
export class EngineModule {}
