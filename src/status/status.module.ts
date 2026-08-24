import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../entities/document.entity';
import { QueuesModule } from '../queues/queues.module';
import { EngineModule } from '../engine/engine.module';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';

@Module({
  imports: [TypeOrmModule.forFeature([Document]), QueuesModule, EngineModule],
  controllers: [StatusController],
  providers: [StatusService],
})
export class StatusModule {}
