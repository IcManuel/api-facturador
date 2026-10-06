import {
  Controller, Get, Put, Post, Delete, Body, HttpCode, HttpStatus, Query, ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SmtpService } from './smtp.service';
import { UpsertSmtpDto } from './dto/upsert-smtp.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Client - SMTP')
@ApiBearerAuth()
@ApiQuery({ name: 'companyId', required: true, type: Number })
@Controller('client/smtp')
export class SmtpController {
  constructor(private readonly service: SmtpService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener configuración SMTP de una empresa de la cuenta' })
  async get(
    @CurrentUser('accountId') accountId: number,
    @Query('companyId', ParseIntPipe) companyId: number,
  ) {
    await this.service.assertCompanyOfAccount(accountId, companyId);
    return this.service.findByCompany(companyId);
  }

  @Put()
  @ApiOperation({ summary: 'Crear o actualizar configuración SMTP' })
  async upsert(
    @CurrentUser('accountId') accountId: number,
    @Query('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpsertSmtpDto,
  ) {
    await this.service.assertCompanyOfAccount(accountId, companyId);
    return this.service.upsert(companyId, dto);
  }

  @Post('test')
  @ApiOperation({ summary: 'Enviar email de prueba con la configuración SMTP' })
  async test(
    @CurrentUser('accountId') accountId: number,
    @CurrentUser('email') email: string,
    @Query('companyId', ParseIntPipe) companyId: number,
  ) {
    await this.service.assertCompanyOfAccount(accountId, companyId);
    return this.service.testConnection(companyId, email);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar configuración SMTP (volver al servidor de la plataforma)' })
  async remove(
    @CurrentUser('accountId') accountId: number,
    @Query('companyId', ParseIntPipe) companyId: number,
  ) {
    await this.service.assertCompanyOfAccount(accountId, companyId);
    return this.service.remove(companyId);
  }
}
