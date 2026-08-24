import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from './config/database.config';
import { AuthModule } from './auth/auth.module';
import { PlansModule } from './admin/plans/plans.module';
import { AccountsModule } from './admin/accounts/accounts.module';
import { CompaniesModule } from './admin/companies/companies.module';
import { DocumentsModule } from './admin/documents/documents.module';
import { BillingModule } from './admin/billing/billing.module';
import { CertificatesModule } from './admin/certificates/certificates.module';
import { LogsModule } from './admin/logs/logs.module';
import { SettingsModule } from './admin/settings/settings.module';
import { DashboardModule } from './admin/dashboard/dashboard.module';
import { PlatformAdminsModule } from './admin/platform-admins/platform-admins.module';
import { ErrorAnalyticsModule } from './admin/error-analytics/error-analytics.module';
import { SystemModule } from './admin/system/system.module';
import { ClientProfileModule } from './client/profile/profile.module';
import { ClientCompaniesModule } from './client/companies/companies.module';
import { ClientDocumentsModule } from './client/documents/documents.module';
import { ClientUsersModule } from './client/users/users.module';
import { ClientDashboardModule } from './client/dashboard/dashboard.module';
import { ClientBillingModule } from './client/billing/billing.module';
import { ClientSmtpModule } from './client/smtp/smtp.module';
import { PublicApiModule } from './public-api/public-api.module';
import { EngineModule } from './engine/engine.module';
import { QueuesModule } from './queues/queues.module';
import { EventsModule } from './events/events.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StatusModule } from './status/status.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseConfig,
    }),
    AuthModule,
    PlansModule,
    AccountsModule,
    CompaniesModule,
    DocumentsModule,
    BillingModule,
    CertificatesModule,
    LogsModule,
    SettingsModule,
    DashboardModule,
    PlatformAdminsModule,
    ErrorAnalyticsModule,
    SystemModule,
    // Client modules
    ClientProfileModule,
    ClientCompaniesModule,
    ClientDocumentsModule,
    ClientUsersModule,
    ClientDashboardModule,
    ClientBillingModule,
    ClientSmtpModule,
    // Public API + Engine
    PublicApiModule,
    EngineModule,
    QueuesModule,
    EventsModule,
    NotificationsModule,
    StatusModule,
  ],
})
export class AppModule {}
