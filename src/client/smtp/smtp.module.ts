import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanySmtp } from '../../entities/company-smtp.entity';
import { Company } from '../../entities/company.entity';
import { CryptoService } from '../../common/services/crypto.service';
import { SmtpController } from './smtp.controller';
import { SmtpService } from './smtp.service';

@Module({
  imports: [TypeOrmModule.forFeature([CompanySmtp, Company])],
  controllers: [SmtpController],
  providers: [SmtpService, CryptoService],
  exports: [SmtpService],
})
export class ClientSmtpModule {}
