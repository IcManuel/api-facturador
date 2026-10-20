import { CobroModule } from '../../cobro/cobro.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../../entities/company.entity';
import { Document } from '../../entities/document.entity';
import { BillingPeriod } from '../../entities/billing-period.entity';
import { Certificate } from '../../entities/certificate.entity';
import { Account } from '../../entities/account.entity';
import { ClientDashboardController } from './dashboard.controller';
import { ClientDashboardService } from './dashboard.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Company, Document, BillingPeriod, Certificate, Account]),
    CobroModule,
  ],
  controllers: [ClientDashboardController],
  providers: [ClientDashboardService],
})
export class ClientDashboardModule {}
