import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Body,
  ParseIntPipe,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiSecurity } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Public } from '../../common/decorators/public.decorator';
import { JwtOrAccountKeyGuard } from '../../common/guards/jwt-or-account-key.guard';
import { ClientCompaniesService } from './companies.service';
import { CreateClientCompanyDto } from './dto/create-client-company.dto';
import { UpdateClientCompanyDto } from './dto/update-client-company.dto';
import { UpdateCompanyRucDto } from './dto/update-company-ruc.dto';
import { SetDocTypesDto } from './dto/set-doc-types.dto';
import { UploadCertificateDto } from './dto/upload-certificate.dto';
import { CreateEmissionPointDto } from '../../admin/companies/dto/create-emission-point.dto';
import { UpdateEmissionPointDto } from '../../admin/companies/dto/update-emission-point.dto';
import { SetSequentialDto } from '../../admin/companies/dto/set-sequential.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { imageFileFilter, resolveImageMime } from '../../common/utils/image-upload.util';
import { CreateEstablishmentDto, UpdateEstablishmentDto } from '../../establishments/dto/establishment.dto';

@ApiTags('Client - Companies')
@ApiBearerAuth()
@ApiSecurity('account-key')
@Public()
@UseGuards(JwtOrAccountKeyGuard)
@Controller('client/companies')
export class ClientCompaniesController {
  constructor(private readonly companiesService: ClientCompaniesService) {}

  @Get('plans/available')
  @ApiOperation({ summary: 'Planes disponibles para auto-asignar' })
  getAvailablePlans(@CurrentUser('accountId') accountId: number) {
    return this.companiesService.getAvailablePlans(accountId);
  }

  @Get()
  @ApiOperation({ summary: 'Listar empresas de la cuenta' })
  findAll(@CurrentUser('accountId') accountId: number) {
    return this.companiesService.findAll(accountId);
  }

  @Post()
  @ApiOperation({ summary: 'Crear empresa en la cuenta' })
  create(
    @CurrentUser('accountId') accountId: number,
    @Body() dto: CreateClientCompanyDto,
  ) {
    return this.companiesService.create(accountId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de empresa' })
  findOne(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.companiesService.findOne(accountId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar configuración de empresa' })
  update(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClientCompanyDto,
  ) {
    return this.companiesService.update(accountId, id, dto);
  }

  @Patch(':id/ruc')
  @ApiOperation({
    summary: 'Cambiar el RUC de la empresa',
    description:
      'Permitido solo mientras la empresa no tenga comprobantes autorizados en producción. Sincroniza el RUC de la cuenta para cuentas de empresa única.',
  })
  updateRuc(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCompanyRucDto,
  ) {
    return this.companiesService.updateRuc(accountId, id, dto.ruc);
  }

  @Post(':id/logo')
  @ApiOperation({ summary: 'Subir logo de empresa' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: imageFileFilter,
    }),
  )
  uploadLogo(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.companiesService.uploadLogo(accountId, id, file.buffer, resolveImageMime(file));
  }

  @Delete(':id/logo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar logo de empresa' })
  deleteLogo(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.companiesService.deleteLogo(accountId, id);
  }

  @Get(':id/logo')
  @ApiOperation({ summary: 'Obtener imagen del logo' })
  async getLogo(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const { logoS3Key } = await this.companiesService.getLogoUrl(accountId, id);
    if (!logoS3Key) throw new NotFoundException('La empresa no tiene logo');

    const buffer = await this.companiesService.downloadLogo(logoS3Key);
    const contentType = logoS3Key.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
    res.send(buffer);
  }

  // ── Doc Types ──

  @Put(':id/doc-types')
  @ApiOperation({ summary: 'Establecer tipos de documento habilitados' })
  setDocTypes(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetDocTypesDto,
  ) {
    return this.companiesService.setDocTypes(accountId, id, dto.codes);
  }

  // ── Certificates ──

  @Post(':id/certificates')
  @ApiOperation({ summary: 'Subir certificado .p12 de firma electrónica' })
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
    @CurrentUser('accountId') accountId: number,
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadCertificateDto,
  ) {
    if (!file) throw new BadRequestException('Archivo .p12 requerido');
    return this.companiesService.uploadCertificate(
      accountId, id, file.buffer, file.originalname, dto.password, userId,
    );
  }

  // ── API Key ──

  @Post(':id/regenerate-key')
  @ApiOperation({ summary: 'Regenerar API Key de la empresa (invalida la anterior)' })
  regenerateApiKey(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.companiesService.regenerateApiKey(accountId, id);
  }

  // ── Emission Points ──

  @Get(':id/establishments')
  @ApiOperation({ summary: 'Listar establecimientos de la empresa' })
  listEstablishments(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.companiesService.listEstablishments(accountId, id);
  }

  @Post(':id/establishments')
  @ApiOperation({
    summary: 'Crear un establecimiento (sucursal)',
    description:
      'Crea una sucursal con su propio código. Se le crea automáticamente el punto de emisión 001. ' +
      'La numeración de cada establecimiento es independiente y arranca en 1.',
  })
  createEstablishment(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateEstablishmentDto,
  ) {
    return this.companiesService.createEstablishment(accountId, id, dto);
  }

  @Patch(':id/establishments/:estId')
  @ApiOperation({ summary: 'Actualizar un establecimiento' })
  updateEstablishment(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('estId', ParseIntPipe) estId: number,
    @Body() dto: UpdateEstablishmentDto,
  ) {
    return this.companiesService.updateEstablishment(accountId, id, estId, dto);
  }

  @Delete(':id/establishments/:estId')
  @ApiOperation({ summary: 'Eliminar un establecimiento sin comprobantes emitidos' })
  deleteEstablishment(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('estId', ParseIntPipe) estId: number,
  ) {
    return this.companiesService.deleteEstablishment(accountId, id, estId);
  }

  @Post(':id/emission-points')
  @ApiOperation({ summary: 'Agregar punto de emisión' })
  addEmissionPoint(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateEmissionPointDto,
  ) {
    return this.companiesService.addEmissionPoint(accountId, id, dto);
  }

  @Patch(':id/emission-points/:empId')
  @ApiOperation({ summary: 'Actualizar punto de emisión' })
  updateEmissionPoint(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('empId', ParseIntPipe) empId: number,
    @Body() dto: UpdateEmissionPointDto,
  ) {
    return this.companiesService.updateEmissionPoint(accountId, id, empId, dto);
  }

  @Delete(':id/emission-points/:empId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar punto de emisión' })
  removeEmissionPoint(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('empId', ParseIntPipe) empId: number,
  ) {
    return this.companiesService.removeEmissionPoint(accountId, id, empId);
  }

  // ── Sequentials ──

  @Get(':id/sequentials')
  @ApiOperation({ summary: 'Listar secuenciales configurados' })
  getSequentials(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.companiesService.getSequentials(accountId, id);
  }

  @Put(':id/sequentials')
  @ApiOperation({ summary: 'Configurar secuencial inicial' })
  setSequential(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetSequentialDto,
  ) {
    return this.companiesService.setSequential(accountId, id, dto);
  }
}
