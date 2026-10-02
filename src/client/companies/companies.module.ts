import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../../entities/company.entity';
import { EmissionPoint } from '../../entities/emission-point.entity';
import { CompanySeries } from '../../entities/company-series.entity';
import { CompanyDocType } from '../../entities/company-doc-type.entity';
import { Account } from '../../entities/account.entity';
import { SubscriptionPlan } from '../../entities/subscription-plan.entity';
import { Document } from '../../entities/document.entity';
import { EngineModule } from '../../engine/engine.module';
import { CertificatesModule } from '../../admin/certificates/certificates.module';
import { AccountApiKeyGuard } from '../../common/guards/account-api-key.guard';
import { JwtOrAccountKeyGuard } from '../../common/guards/jwt-or-account-key.guard';
import { ClientCompaniesController } from './companies.controller';
import { ClientCompaniesService } from './companies.service';
import { EstablishmentsModule } from '../../establishments/establishments.module';

@Module({
  imports: [
    EstablishmentsModule,
    TypeOrmModule.forFeature([Company, EmissionPoint, CompanySeries, CompanyDocType, Account, SubscriptionPlan, Document]),
    EngineModule,
    CertificatesModule,
  ],
  controllers: [ClientCompaniesController],
  providers: [ClientCompaniesService, AccountApiKeyGuard, JwtOrAccountKeyGuard],
})
export class ClientCompaniesModule {}
