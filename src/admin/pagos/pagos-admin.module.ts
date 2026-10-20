import { Module } from '@nestjs/common';
import { PagosAdminController } from './pagos-admin.controller';
import { PagosAdminService } from './pagos-admin.service';

@Module({
  controllers: [PagosAdminController],
  providers: [PagosAdminService],
})
export class PagosAdminModule {}
