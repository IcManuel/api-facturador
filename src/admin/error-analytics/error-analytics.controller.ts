import { Controller, Get, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ErrorAnalyticsService } from './error-analytics.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Error Analytics')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/error-analytics')
export class ErrorAnalyticsController {
  constructor(private readonly service: ErrorAnalyticsService) {}

  @Get()
  @ApiOperation({ summary: 'Análisis de errores y rechazos de documentos' })
  @ApiQuery({ name: 'from', required: false, description: 'Fecha inicio (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Fecha fin (YYYY-MM-DD)' })
  @ApiQuery({ name: 'category', required: false, enum: ['client', 'system'] })
  @ApiQuery({ name: 'severity', required: false, enum: ['warning', 'error', 'critical'] })
  @ApiQuery({ name: 'companyId', required: false, type: Number })
  @ApiQuery({ name: 'docTypeCode', required: false, enum: ['01', '03', '04', '05', '06', '07'] })
  @ApiQuery({ name: 'env', required: false, enum: ['production', 'test'] })
  getAnalytics(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('companyId') companyId?: string,
    @Query('docTypeCode') docTypeCode?: string,
    @Query('env') env?: string,
  ) {
    return this.service.getAnalytics({
      from,
      to,
      category,
      severity,
      companyId: companyId ? Number(companyId) : undefined,
      docTypeCode,
      env,
    });
  }

  @Get('recent-errors')
  @ApiOperation({ summary: 'Errores recientes paginados' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'category', required: false, enum: ['client', 'system'] })
  @ApiQuery({ name: 'severity', required: false, enum: ['warning', 'error', 'critical'] })
  @ApiQuery({ name: 'companyId', required: false, type: Number })
  @ApiQuery({ name: 'docTypeCode', required: false, enum: ['01', '03', '04', '05', '06', '07'] })
  @ApiQuery({ name: 'env', required: false, enum: ['production', 'test'] })
  getRecentErrors(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(15), ParseIntPipe) limit: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('companyId') companyId?: string,
    @Query('docTypeCode') docTypeCode?: string,
    @Query('env') env?: string,
  ) {
    return this.service.getRecentErrors(
      {
        from,
        to,
        category,
        severity,
        companyId: companyId ? Number(companyId) : undefined,
        docTypeCode,
        env,
      },
      page,
      limit,
    );
  }
}
