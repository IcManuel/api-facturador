import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsArray, IsEnum } from 'class-validator';

import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { CreateEmissionPointDto } from './dto/create-emission-point.dto';
import { UpdateEmissionPointDto } from './dto/update-emission-point.dto';
import { SetSequentialDto } from './dto/set-sequential.dto';
import { CompanyStatus, SriDocTypeCode } from '../../entities/enums';
import { SmtpService } from '../../client/smtp/smtp.service';
import { UpsertSmtpDto } from '../../client/smtp/dto/upsert-smtp.dto';
import { imageFileFilter, resolveImageMime } from '../../common/utils/image-upload.util';

class SetDocTypesDto {
  @IsArray()
  @IsEnum(SriDocTypeCode, { each: true })
  codes: SriDocTypeCode[];
}

@ApiTags('Admin - Empresas')
@ApiBearerAuth()
@Controller('admin/companies')
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly smtpService: SmtpService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar empresas con paginación y filtros' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'accountId', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: CompanyStatus })
  findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('search') search?: string,
    @Query('accountId') accountId?: number,
    @Query('status') status?: CompanyStatus,
  ) {
    return this.companiesService.findAll(
      +page,
      +limit,
      search,
      accountId ? +accountId : undefined,
      status,
    );
  }

  @Get('monthly-activity')
  @ApiOperation({
    summary: 'Reporte de actividad mensual por empresa',
    description: 'Devuelve, por empresa, el número de documentos emitidos por mes en el año indicado, más el total y el promedio mensual. Opcionalmente filtrable por ambiente.',
  })
  @ApiQuery({ name: 'year', required: false, type: Number, description: 'Año a consultar (default: año actual)' })
  @ApiQuery({ name: 'env', required: false, enum: ['production', 'test', 'all'], description: 'Filtrar por ambiente (default: all)' })
  getMonthlyActivity(
    @Query('year') year?: string,
    @Query('env') env?: 'production' | 'test' | 'all',
  ) {
    const y = year ? Number(year) : new Date().getFullYear();
    return this.companiesService.getMonthlyActivity(y, env ?? 'all');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener empresa por ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.companiesService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear nueva empresa' })
  create(@Body() dto: CreateCompanyDto) {
    return this.companiesService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar empresa' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companiesService.update(id, dto);
  }

  @Post(':id/emission-points')
  @ApiOperation({ summary: 'Agregar punto de emisión a empresa' })
  addEmissionPoint(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateEmissionPointDto,
  ) {
    return this.companiesService.addEmissionPoint(id, dto);
  }

  @Patch(':id/emission-points/:empId')
  @ApiOperation({ summary: 'Actualizar punto de emisión' })
  updateEmissionPoint(
    @Param('id', ParseIntPipe) id: number,
    @Param('empId', ParseIntPipe) empId: number,
    @Body() dto: UpdateEmissionPointDto,
  ) {
    return this.companiesService.updateEmissionPoint(id, empId, dto);
  }

  @Delete(':id/emission-points/:empId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar punto de emisión de empresa' })
  removeEmissionPoint(
    @Param('id', ParseIntPipe) id: number,
    @Param('empId', ParseIntPipe) empId: number,
  ) {
    return this.companiesService.removeEmissionPoint(id, empId);
  }

  @Get(':id/sequentials')
  @ApiOperation({ summary: 'Listar secuenciales configurados' })
  getSequentials(@Param('id', ParseIntPipe) id: number) {
    return this.companiesService.getSequentials(id);
  }

  @Put(':id/sequentials')
  @ApiOperation({ summary: 'Configurar secuencial inicial para un tipo de documento y punto de emisión' })
  setSequential(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetSequentialDto,
  ) {
    return this.companiesService.setSequential(id, dto);
  }

  @Put(':id/doc-types')
  @ApiOperation({ summary: 'Establecer tipos de documento habilitados' })
  setDocTypes(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetDocTypesDto,
  ) {
    return this.companiesService.setDocTypes(id, dto.codes);
  }

  @Post(':id/logo')
  @ApiOperation({ summary: 'Subir logo de empresa' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
      fileFilter: imageFileFilter,
    }),
  )
  uploadLogo(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.companiesService.uploadLogo(id, file.buffer, resolveImageMime(file));
  }

  @Delete(':id/logo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar logo de empresa' })
  deleteLogo(@Param('id', ParseIntPipe) id: number) {
    return this.companiesService.deleteLogo(id);
  }

  @Get(':id/logo')
  @ApiOperation({ summary: 'Obtener imagen del logo' })
  async getLogo(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const { logoS3Key } = await this.companiesService.getLogoUrl(id);
    if (!logoS3Key) throw new NotFoundException('La empresa no tiene logo');

    const buffer = await this.companiesService.downloadLogo(logoS3Key);
    const contentType = logoS3Key.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
    res.send(buffer);
  }

  // ── SMTP ──────────────────────────────────────────────────

  @Get(':id/smtp')
  @ApiOperation({ summary: 'Obtener configuración SMTP de una empresa' })
  getSmtp(@Param('id', ParseIntPipe) id: number) {
    return this.smtpService.findByCompany(id);
  }

  @Put(':id/smtp')
  @ApiOperation({ summary: 'Crear o actualizar configuración SMTP de una empresa' })
  upsertSmtp(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertSmtpDto,
  ) {
    return this.smtpService.upsert(id, dto);
  }

  @Post(':id/smtp/test')
  @ApiOperation({ summary: 'Enviar email de prueba con la configuración SMTP de una empresa' })
  testSmtp(
    @Param('id', ParseIntPipe) id: number,
    @Body('email') email: string,
  ) {
    if (!email) throw new BadRequestException('Se requiere un email para la prueba');
    return this.smtpService.testConnection(id, email);
  }

  @Delete(':id/smtp')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar configuración SMTP de una empresa' })
  removeSmtp(@Param('id', ParseIntPipe) id: number) {
    return this.smtpService.remove(id);
  }
}
