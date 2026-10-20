import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  UseInterceptors,
  UploadedFile,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { CertificatesService } from './certificates.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Certificados')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/certificates')
export class CertificatesController {
  constructor(private readonly service: CertificatesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar certificados digitales' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'companyId', type: Number, required: false })
  @ApiQuery({ name: 'expiringSoon', type: Boolean, required: false })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('companyId') companyId?: number,
    @Query('expiringSoon') expiringSoon?: string,
  ) {
    return this.service.findAll(
      page,
      limit,
      companyId ? +companyId : undefined,
      expiringSoon === 'true',
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de certificado' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Subir certificado .p12 para una empresa' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'password', 'companyId'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Archivo .p12' },
        password: { type: 'string', description: 'Contrasena del certificado' },
        companyId: { type: 'number', description: 'ID de la empresa' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 }, // 50 KB max for .p12
      fileFilter: (_req, file, cb) => {
        const ext = file.originalname.toLowerCase();
        if (!ext.endsWith('.p12') && !ext.endsWith('.pfx')) {
          cb(new BadRequestException('Solo se permiten archivos .p12 o .pfx'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('password') password: string,
    @Body('companyId') companyId: string,
    @CurrentUser() user: any,
  ) {
    if (!file) {
      throw new BadRequestException('Debe adjuntar un archivo .p12');
    }
    if (!password) {
      throw new BadRequestException('La contrasena del certificado es requerida');
    }
    if (!companyId) {
      throw new BadRequestException('El ID de la empresa es requerido');
    }

    const result = await this.service.upload(
      Number(companyId),
      file.buffer,
      file.originalname,
      password,
      user?.sub ?? null,
    );

    return {
      message: 'Certificado subido y validado exitosamente',
      certificate: {
        id: result.certificate.id,
        fileName: result.certificate.fileName,
        subjectCn: result.certificate.subjectCn,
        expiresAt: result.certificate.expiresAt,
        isCurrent: result.certificate.isCurrent,
      },
      validation: {
        subjectCn: result.validation.subjectCn,
        issuerCn: result.validation.issuerCn,
        validFrom: result.validation.validFrom,
        validTo: result.validation.validTo,
        daysUntilExpiry: result.validation.daysUntilExpiry,
      },
    };
  }
}
