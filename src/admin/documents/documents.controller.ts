import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { DocStatus, SriDocTypeCode, CompanyEnv } from '../../entities/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Documentos')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar documentos con filtros' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'status', enum: DocStatus, required: false })
  @ApiQuery({ name: 'companyId', type: Number, required: false })
  @ApiQuery({ name: 'typeCode', enum: SriDocTypeCode, required: false })
  @ApiQuery({ name: 'dateFrom', type: String, required: false })
  @ApiQuery({ name: 'dateTo', type: String, required: false })
  @ApiQuery({ name: 'env', enum: CompanyEnv, required: false })
  @ApiQuery({ name: 'search', type: String, required: false })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: DocStatus,
    @Query('companyId') companyId?: number,
    @Query('typeCode') typeCode?: SriDocTypeCode,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('env') env?: CompanyEnv,
    @Query('search') search?: string,
  ) {
    return this.service.findAll(
      page,
      limit,
      status,
      companyId ? +companyId : undefined,
      typeCode,
      dateFrom,
      dateTo,
      env,
      search,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Conteo de documentos por estado' })
  getStats() {
    return this.service.getStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de documento' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post(':id/reissue-today')
  @ApiOperation({
    summary: 'Reemitir documento con fecha de hoy',
    description:
      'Para documentos en REJECTED/FAILED: consulta primero al SRI por la clave actual (por si quedó autorizado), si no, regenera la clave de acceso con la fecha de hoy, mantiene el secuencial, reconstruye el XML, lo firma y lo reenvía.',
  })
  reissueToday(@Param('id', ParseIntPipe) id: number) {
    return this.service.reissueToday(id);
  }

  @Get(':id/files/:fileType')
  @ApiOperation({ summary: 'Descargar archivo de documento (signed_xml, authorized_xml, ride)' })
  @ApiParam({ name: 'fileType', enum: ['signed_xml', 'authorized_xml', 'ride'] })
  async downloadFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('fileType') fileType: string,
    @Res() res: Response,
  ) {
    const { buffer, filename, contentType } = await this.service.downloadFile(id, fileType);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }
}
