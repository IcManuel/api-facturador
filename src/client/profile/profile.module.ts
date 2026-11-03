import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../../entities/account.entity';
import { Company } from '../../entities/company.entity';
import { AccountUser } from '../../entities/account-user.entity';
import { ClientProfileController } from './profile.controller';
import { ClientProfileService } from './profile.service';

@Module({
  imports: [TypeOrmModule.forFeature([Account, Company, AccountUser])],
  controllers: [ClientProfileController],
  providers: [ClientProfileService],
})
export class ClientProfileModule {}
