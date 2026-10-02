import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Establishment } from '../entities/establishment.entity';
import { EmissionPoint } from '../entities/emission-point.entity';
import { Company } from '../entities/company.entity';
import { Document } from '../entities/document.entity';
import { EstablishmentsService } from './establishments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Establishment, EmissionPoint, Company, Document])],
  providers: [EstablishmentsService],
  exports: [EstablishmentsService],
})
export class EstablishmentsModule {}
