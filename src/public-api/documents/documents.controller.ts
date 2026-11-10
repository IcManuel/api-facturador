import {
  Controller, Get, Post, Put, Body, Param, Query, Res, UseGuards,
  ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity, ApiQuery, ApiParam } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentCompany } from '../guards/current-company.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Company } from '../../entities/company.entity';
import { DocStatus } from '../../entities/enums';
import { PublicDocumentsService } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';

@ApiTags('API Pública - Documentos')
@ApiSecurity('api-key')
@Public() // Bypass JWT guard — this uses API key guard instead
@UseGuards(ApiKeyGuard)
@Controller('documents')
export class PublicDocumentsController {
  constructor(private readonly service: PublicDocumentsService) {}

  @Post()
  @ApiOperation({ summary: 'Enviar documento electrónico (procesamiento asíncrono en cola)' })
  create(
    @CurrentCompany() company: Company,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.service.create(company, dto);
  }

  @Post('emit')
  @ApiOperation({
    summary: 'Emitir documento electrónico (procesamiento síncrono)',
    description:
      'Crea el documento, genera XML, firma, envía al SRI y espera la autorización en la misma petición. ' +
      'Si el procesamiento falla, el documento se encola automáticamente para reintento. ' +
      'Tiempo de respuesta típico: 5-15 segundos.',
  })
  createSync(
    @CurrentCompany() company: Company,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.service.createSync(company, dto);
  }

  @Put(':claveAcceso')
  @ApiOperation({
    summary: 'Corregir documento y reprocesar (asíncrono)',
    description:
      'Permite corregir el payload de un documento en estado CREATED, REJECTED o FAILED identificándolo por su clave de acceso (49 dígitos). ' +
      'Limpia el historial anterior, actualiza los datos y lo encola para reprocesamiento.',
  })
  @ApiParam({ name: 'claveAcceso', description: 'Clave de acceso del documento (49 dígitos)', example: '0601202501010392aboriel32880001001001000000001234567817' })
  correct(
    @CurrentCompany() company: Company,
    @Param('claveAcceso') accessKey: string,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.service.correct(company, accessKey, dto);
  }

  @Put(':claveAcceso/emit')
  @ApiOperation({
    summary: 'Corregir documento y reprocesar (síncrono)',
    description:
      'Permite corregir el payload de un documento en estado CREATED, REJECTED o FAILED identificándolo por su clave de acceso (49 dígitos). ' +
      'Limpia el historial anterior, actualiza los datos y procesa de forma síncrona.',
  })
  @ApiParam({ name: 'claveAcceso', description: 'Clave de acceso del documento (49 dígitos)', example: '0601202501010392adoriel32880001001001000000001234567817' })
  correctSync(
    @CurrentCompany() company: Company,
    @Param('claveAcceso') accessKey: string,
    @Body() dto: CreateDocumentDto,
  ) {
    return this.service.correctSync(company, accessKey, dto);
  }

  @Post(':claveAcceso/retry-authorization')
  @ApiOperation({
    summary: 'Reintentar autorización SRI',
    description:
      'Para documentos en estado RECEIVED (el SRI los recibió pero no los ha autorizado aún). ' +
      'Identifica el documento por su clave de acceso (49 dígitos). ' +
      'Consulta la autorización inmediatamente y encola un reintento automático si sigue en procesamiento.',
  })
  @ApiParam({ name: 'claveAcceso', description: 'Clave de acceso del documento (49 dígitos)' })
  retryAuthorization(
    @CurrentCompany('id') companyId: number,
    @Param('claveAcceso') accessKey: string,
  ) {
    return this.service.retryAuthorization(companyId, accessKey);
  }

  @Get()
  @ApiOperation({ summary: 'Listar documentos de la empresa' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'status', enum: DocStatus, required: false })
  @ApiQuery({ name: 'from', type: String, required: false, description: 'Fecha desde (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', type: String, required: false, description: 'Fecha hasta (YYYY-MM-DD)' })
  findAll(
    @CurrentCompany('id') companyId: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: DocStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.findAll(companyId, page, limit, status, from, to);
  }

  @Get('by-idempotency-key/:key')
  @ApiOperation({
    summary: 'Buscar documento por idempotencyKey',
    description:
      'Devuelve el documento asociado al idempotencyKey si existe en esta empresa y en su ambiente actual, o 404 si nunca llegó. Útil cuando una llamada de emisión sufrió un timeout y se desconoce si el documento se procesó.',
  })
  @ApiParam({ name: 'key', description: 'idempotencyKey enviado en la emisión' })
  findByIdempotencyKey(
    @CurrentCompany() company: Company,
    @Param('key') key: string,
  ) {
    return this.service.findByIdempotencyKey(company, key);
  }

  @Get(':claveAcceso')
  @ApiOperation({
    summary: 'Detalle de un documento (estado, timeline, errores, archivos)',
    description: 'Obtiene el detalle completo de un documento identificándolo por su clave de acceso (49 dígitos).',
  })
  @ApiParam({ name: 'claveAcceso', description: 'Clave de acceso del documento (49 dígitos)' })
  findOne(
    @CurrentCompany('id') companyId: number,
    @Param('claveAcceso') accessKey: string,
  ) {
    return this.service.findOne(companyId, accessKey);
  }

  @Get(':claveAcceso/files/:fileType')
  @ApiOperation({
    summary: 'Descargar archivo de un documento',
    description:
      'Descarga el XML firmado, XML autorizado o RIDE (PDF) de un documento identificándolo por su clave de acceso. ' +
      'Retorna el archivo binario con el Content-Type apropiado. ' +
      'Para el RIDE, puede forzar la regeneración con ?regenerate=true.',
  })
  @ApiParam({ name: 'claveAcceso', description: 'Clave de acceso del documento (49 dígitos)' })
  @ApiParam({ name: 'fileType', description: 'Tipo de archivo a descargar', enum: ['signed_xml', 'authorized_xml', 'ride'] })
  @ApiQuery({ name: 'regenerate', required: false, type: Boolean, description: 'Forzar regeneración del RIDE (solo para fileType=ride)' })
  async downloadFile(
    @CurrentCompany('id') companyId: number,
    @Param('claveAcceso') accessKey: string,
    @Param('fileType') fileType: string,
    @Query('regenerate') regenerate: string,
    @Res() res: Response,
  ) {
    const shouldRegenerate = fileType === 'ride' && (regenerate === 'true' || regenerate === '1');
    const { buffer, filename, contentType } = await this.service.downloadFile(companyId, accessKey, fileType, shouldRegenerate);

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }
}
