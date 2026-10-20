import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Dashboard')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Estadísticas generales del dashboard admin' })
  getStats() {
    return this.service.getStats();
  }
}
