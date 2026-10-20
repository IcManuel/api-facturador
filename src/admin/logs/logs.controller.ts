import {
  Controller,
  Get,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { LogsService } from './logs.service';
import { LogType, LogLevel } from '../../entities/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Logs')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/logs')
export class LogsController {
  constructor(private readonly service: LogsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar logs del sistema' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'type', enum: LogType, required: false })
  @ApiQuery({ name: 'level', enum: LogLevel, required: false })
  @ApiQuery({ name: 'companyId', type: Number, required: false })
  @ApiQuery({ name: 'search', type: String, required: false })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') type?: LogType,
    @Query('level') level?: LogLevel,
    @Query('companyId') companyId?: number,
    @Query('search') search?: string,
  ) {
    return this.service.findAll(
      page,
      limit,
      type,
      level,
      companyId ? +companyId : undefined,
      search,
    );
  }

  @Get('summary')
  @ApiOperation({ summary: 'Resumen de logs del sistema' })
  getSummary() {
    return this.service.getSummary();
  }
}
