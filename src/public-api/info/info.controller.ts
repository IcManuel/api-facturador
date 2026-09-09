import {
  Controller, Get, Put, Post, Patch, Delete, Param, Body, Res, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException, NotFoundException, ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiSecurity, ApiConsumes, ApiParam } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentCompany } from '../guards/current-company.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Company } from '../../entities/company.entity';
import { InfoService } from './info.service';
import { UpdateEnvironmentDto } from './dto/update-environment.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UploadCertificateDto } from '../../client/companies/dto/upload-certificate.dto';
import { CreateEmissionPointDto } from '../../admin/companies/dto/create-emission-point.dto';
import { UpdateEmissionPointDto } from '../../admin/companies/dto/update-emission-point.dto';
import { SetSequentialDto } from '../../admin/companies/dto/set-sequential.dto';
import { UpdateCompanyInfoDto } from './dto/update-company-info.dto';
import { UpdateCompanyRucDto } from './dto/update-company-ruc.dto';
import { imageFileFilter, resolveImageMime } from '../../common/utils/image-upload.util';

@ApiTags('API Pública - Empresa')
@ApiSecurity('api-key')
@Public()
@UseGuards(ApiKeyGuard)
@Controller('company')
export class InfoController {
  constructor(private readonly service: InfoService) {}

  // ── Read ──

  @Get()
  @ApiOperation({ summary: 'Información de la empresa autenticada' })
  getCompany(@CurrentCompany() company: Company) {
    return this.service.getCompanyInfo(company);
  }

  @Patch()
  @ApiOperation({
    summary: 'Actualizar datos generales de la empresa',
    description: 'Modifica razón social, nombre comercial, email, teléfono y/o dirección. Todos los campos son opcionales; envíe solo los que desea cambiar. Para cambiar el RUC use PATCH /company/ruc.',
  })
  updateCompany(
    @CurrentCompany() company: Company,
    @Body() dto: UpdateCompanyInfoDto,
  ) {
    return this.service.updateInfo(company, dto);
  }

  @Patch('ruc')
  @ApiOperation({
    summary: 'Cambiar el RUC de la empresa',
    description: 'Permitido solo mientras la empresa no tenga comprobantes autorizados en producción. Sincroniza el RUC de la cuenta para cuentas de empresa única.',
  })
  updateRuc(
    @CurrentCompany() company: Company,
    @Body() dto: UpdateCompanyRucDto,
  ) {
    return this.service.updateRuc(company, dto.ruc);
  }

  @Get('certificate')
  @ApiOperation({ summary: 'Estado del certificado digital' })
  getCertificate(@CurrentCompany('id') companyId: number) {
    return this.service.getCertificateInfo(companyId);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Uso de documentos del mes actual vs límite del plan' })
  getUsage(@CurrentCompany() company: Company) {
    return this.service.getUsageInfo(company);
  }

  // ── Self-management ──

  @Put('environment')
  @ApiOperation({ summary: 'Cambiar ambiente SRI (test/production)' })
  updateEnvironment(
    @CurrentCompany('id') companyId: number,
    @Body() dto: UpdateEnvironmentDto,
  ) {
    return this.service.updateEnvironment(companyId, dto.env);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Actualizar configuración (webhook, notificaciones)' })
  updateSettings(
    @CurrentCompany('id') companyId: number,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.service.updateSettings(companyId, dto);
  }

  @Post('certificate')
  @ApiOperation({ summary: 'Subir certificado de firma electrónica (.p12)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.p12')) {
          cb(new BadRequestException('Solo se permiten archivos .p12'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadCertificate(
    @CurrentCompany('id') companyId: number,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadCertificateDto,
  ) {
    if (!file) throw new BadRequestException('Archivo .p12 requerido');
    return this.service.uploadCertificate(companyId, file.buffer, file.originalname, dto.password);
  }

  // ── Secuenciales ──

  @Get('sequentials')
  @ApiOperation({
    summary: 'Listar secuenciales de la empresa',
    description: 'Devuelve, por serie (tipo de documento + establecimiento + punto de emisión), el próximo secuencial que se usará.',
  })
  getSequentials(@CurrentCompany('id') companyId: number) {
    return this.service.getSequentials(companyId);
  }

  @Put('sequentials')
  @ApiOperation({
    summary: 'Fijar el próximo secuencial de una serie',
    description: 'Útil al migrar desde otro sistema para continuar la numeración en vez de arrancar en 1. Crea la serie si no existe.',
  })
  setSequential(
    @CurrentCompany('id') companyId: number,
    @Body() dto: SetSequentialDto,
  ) {
    return this.service.setSequential(companyId, dto);
  }

  @Post('regenerate-key')
  @ApiOperation({ summary: 'Regenerar API Key de la empresa (invalida la anterior)' })
  regenerateApiKey(@CurrentCompany('id') companyId: number) {
    return this.service.regenerateApiKey(companyId);
  }

  // ── Logo (aparece en el RIDE/PDF) ──

  @Post('logo')
  @ApiOperation({ summary: 'Subir logo de la empresa (aparece en el RIDE/PDF)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: imageFileFilter,
    }),
  )
  uploadLogo(
    @CurrentCompany() company: Company,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo de imagen requerido (campo "file").');
    return this.service.uploadLogo(company, file.buffer, resolveImageMime(file));
  }

  @Get('logo')
  @ApiOperation({ summary: 'Descargar el logo actual de la empresa' })
  async getLogo(@CurrentCompany('id') companyId: number, @Res() res: Response) {
    const logo = await this.service.getLogo(companyId);
    if (!logo) throw new NotFoundException('La empresa no tiene logo cargado.');
    res.set({ 'Content-Type': logo.contentType, 'Content-Length': logo.buffer.length });
    res.end(logo.buffer);
  }

  @Delete('logo')
  @ApiOperation({ summary: 'Eliminar el logo de la empresa' })
  deleteLogo(@CurrentCompany() company: Company) {
    return this.service.deleteLogo(company);
  }

  // ── Emission points ──

  @Get('emission-points')
  @ApiOperation({ summary: 'Listar puntos de emisión de la empresa' })
  listEmissionPoints(@CurrentCompany('id') companyId: number) {
    return this.service.listEmissionPoints(companyId);
  }

  @Post('emission-points')
  @ApiOperation({ summary: 'Crear un punto de emisión' })
  createEmissionPoint(
    @CurrentCompany('id') companyId: number,
    @Body() dto: CreateEmissionPointDto,
  ) {
    return this.service.createEmissionPoint(companyId, dto);
  }

  @Patch('emission-points/:empId')
  @ApiOperation({ summary: 'Actualizar un punto de emisión' })
  @ApiParam({ name: 'empId', type: Number })
  updateEmissionPoint(
    @CurrentCompany('id') companyId: number,
    @Param('empId', ParseIntPipe) empId: number,
    @Body() dto: UpdateEmissionPointDto,
  ) {
    return this.service.updateEmissionPoint(companyId, empId, dto);
  }

  @Delete('emission-points/:empId')
  @ApiOperation({ summary: 'Eliminar un punto de emisión' })
  @ApiParam({ name: 'empId', type: Number })
  deleteEmissionPoint(
    @CurrentCompany('id') companyId: number,
    @Param('empId', ParseIntPipe) empId: number,
  ) {
    return this.service.deleteEmissionPoint(companyId, empId);
  }
}
