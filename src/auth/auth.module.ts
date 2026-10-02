import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AccountStatusGuard } from '../common/guards/account-status.guard';
import { MailService } from '../common/services/mail.service';
import { RefreshTokenService } from './refresh-token.service';
import { PlatformAdmin } from '../entities/platform-admin.entity';
import { AccountUser } from '../entities/account-user.entity';
import { Account } from '../entities/account.entity';
import { Company } from '../entities/company.entity';
import { EmissionPoint } from '../entities/emission-point.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { EstablishmentsModule } from '../establishments/establishments.module';

@Module({
  imports: [
    EstablishmentsModule,
    ConfigModule,
    TypeOrmModule.forFeature([PlatformAdmin, AccountUser, Account, Company, EmissionPoint, SubscriptionPlan]),
    NotificationsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '15m') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    MailService,
    RefreshTokenService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AccountStatusGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
