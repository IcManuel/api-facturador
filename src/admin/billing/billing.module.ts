import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingPeriod } from '../../entities/billing-period.entity';
import { Payment } from '../../entities/payment.entity';
import { Account } from '../../entities/account.entity';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingCron } from './billing.cron';
import { CollectionsReportCron } from './collections-report.cron';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RedisLockService } from '../../common/services/redis-lock.service';
import { CobroModule } from '../../cobro/cobro.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BillingPeriod, Payment, Account]),
    NotificationsModule,
    CobroModule,
  ],
  controllers: [BillingController],
  providers: [BillingService, BillingCron, CollectionsReportCron, RedisLockService],
  exports: [BillingService],
})
export class BillingModule {}
