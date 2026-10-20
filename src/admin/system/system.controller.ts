import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { SriService } from '../../engine/sri/sri.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Sistema')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/system')
export class SystemController {
  constructor(private readonly sri: SriService) {}

  @Get('sri-circuit')
  @ApiOperation({ summary: 'Estado del circuit breaker del SRI (production y test)' })
  getSriCircuit() {
    return this.sri.getCircuitStatus();
  }

  @Post('sri-circuit/reset')
  @ApiOperation({ summary: 'Cerrar manualmente el circuit breaker del SRI (tras un incidente)' })
  @ApiQuery({ name: 'env', enum: ['production', 'test'], required: false })
  resetSriCircuit(@Query('env') env?: 'production' | 'test') {
    this.sri.resetCircuit(env);
    return { ok: true, reset: env ?? 'all', status: this.sri.getCircuitStatus() };
  }
}
