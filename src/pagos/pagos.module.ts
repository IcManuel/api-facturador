import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { CobroModule } from '../cobro/cobro.module';
import { RedisLockService } from '../common/services/redis-lock.service';
import { PagosService } from './pagos.service';
import { CobrosService } from './cobros.service';
import { AvisosService } from './avisos.service';
import { RevisionPagosCron } from './revision-pagos.cron';
import { CobranzaCron } from './cobranza.cron';
import { ClientPagosController, PagosHookController } from './pagos.controller';

@Module({
  imports: [NotificationsModule, CobroModule],
  controllers: [ClientPagosController, PagosHookController],
  providers: [
    PagosService,
    CobrosService,
    AvisosService,
    RevisionPagosCron,
    CobranzaCron,
    RedisLockService,
  ],
  exports: [PagosService],
})
export class PagosModule {}
