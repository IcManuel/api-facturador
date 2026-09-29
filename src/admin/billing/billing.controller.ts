import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { CollectionsReportCron } from './collections-report.cron';
import { BillingStatus } from '../../entities/enums';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Admin - Facturación')
@ApiBearerAuth()
@Controller('admin/billing')
export class BillingController {
  constructor(
    private readonly service: BillingService,
    private readonly collectionsReport: CollectionsReportCron,
  ) {}

  @Get('collections-report')
  @ApiOperation({
    summary: 'Reporte de cobros del día (quién debe pagar hoy)',
    description:
      'Devuelve las cuentas activas cuyo día de corte cae en la fecha indicada, con el monto a cobrar. ' +
      'Con send=true además envía el correo, igual que el cron diario de las 08:00.',
  })
  @ApiQuery({ name: 'date', type: String, required: false, description: 'YYYY-MM-DD (por defecto, hoy)' })
  @ApiQuery({ name: 'send', type: Boolean, required: false, description: 'true para enviar el correo' })
  async collectionsReportToday(
    @Query('date') date?: string,
    @Query('send') send?: string,
  ) {
    let when = new Date();
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new BadRequestException('date debe tener formato YYYY-MM-DD');
      }
      when = new Date(`${date}T12:00:00`);
    }
    if (send === 'true' || send === '1') {
      return this.collectionsReport.sendReport(when);
    }
    return this.service.getCollectionsDueToday(when);
  }

  @Get()
  @ApiOperation({ summary: 'Listar periodos de facturación' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'accountId', type: Number, required: false })
  @ApiQuery({ name: 'status', enum: BillingStatus, required: false })
  @ApiQuery({ name: 'year', type: Number, required: false })
  @ApiQuery({ name: 'month', type: Number, required: false })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('accountId') accountId?: number,
    @Query('status') status?: BillingStatus,
    @Query('year') year?: number,
    @Query('month') month?: number,
  ) {
    return this.service.findAll(
      page,
      limit,
      accountId ? +accountId : undefined,
      status,
      year ? +year : undefined,
      month ? +month : undefined,
    );
  }

  @Post('generate')
  @ApiOperation({ summary: 'Generar periodos de facturación para un mes' })
  async generateBillingPeriods(
    @Body() body: { year: number; month: number },
  ) {
    if (!body.year || !body.month || body.month < 1 || body.month > 12) {
      throw new BadRequestException('Debe indicar year y month válidos');
    }
    return this.service.generateBillingPeriods(body.year, body.month);
  }

  @Get('debt-summary')
  @ApiOperation({ summary: 'Resumen de deuda por cuenta' })
  getDebtSummary() {
    return this.service.getDebtSummary();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de periodo de facturación' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post(':id/payments')
  @ApiOperation({ summary: 'Registrar pago/abono a un periodo' })
  addPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreatePaymentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.addPayment(id, dto, user?.email ?? 'admin');
  }

  @Delete(':bpId/payments/:payId')
  @ApiOperation({ summary: 'Eliminar un pago registrado' })
  removePayment(
    @Param('bpId', ParseIntPipe) bpId: number,
    @Param('payId', ParseIntPipe) payId: number,
  ) {
    return this.service.removePayment(bpId, payId);
  }
}
