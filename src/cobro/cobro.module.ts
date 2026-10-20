import { Module } from '@nestjs/common';
import { CobroUsoService } from './cobro-uso.service';

@Module({
  providers: [CobroUsoService],
  exports: [CobroUsoService],
})
export class CobroModule {}
