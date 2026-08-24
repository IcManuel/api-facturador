import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { StatusService } from './status.service';

@ApiTags('Status')
@Public()
@Controller('status')
export class StatusController {
  constructor(private readonly service: StatusService) {}

  @Get()
  @ApiOperation({ summary: 'Estado en vivo de la plataforma (API, base de datos, cola, SRI test/producción)' })
  getStatus() {
    return this.service.getStatus();
  }
}
