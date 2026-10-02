import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '../../entities/company.entity';
import { EmissionPoint } from '../../entities/emission-point.entity';
import { CompanyDocType } from '../../entities/company-doc-type.entity';
import { CompanySeries } from '../../entities/company-series.entity';
import { CompanySmtp } from '../../entities/company-smtp.entity';
import { EngineModule } from '../../engine/engine.module';
import { ClientSmtpModule } from '../../client/smtp/smtp.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { EstablishmentsModule } from '../../establishments/establishments.module';

@Module({
  imports: [
    EstablishmentsModule,
    TypeOrmModule.forFeature([Company, EmissionPoint, CompanyDocType, CompanySeries, CompanySmtp]),
    EngineModule,
    ClientSmtpModule,
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
