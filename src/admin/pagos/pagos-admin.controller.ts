import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';
import { PagosAdminService } from './pagos-admin.service';

const ESTADOS = [
  'PENDIENTE',
  'REPORTADO',
  'PAGADO',
  'RECHAZADO',
  'EXPIRADO',
  'ERROR',
  'REVISAR',
];
const RESULTADOS = [
  'RECIBIDA',
  'APLICADA',
  'REPETIDA',
  'RECHAZO',
  'SIN_PAGO',
  'MONTO',
  'IGNORADA',
  'ERROR',
  'REVISAR',
];

/** Pagos en línea (PagoPlux) para revisar. Solo lectura: las correcciones se registran en Facturación. */
@ApiTags('Admin - Pagos en línea')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/pagos')
export class PagosAdminController {
  constructor(private readonly service: PagosAdminService) {}

  @Get('resumen')
  @ApiOperation({
    summary:
      'Contadores: pagos con error, sin confirmar, avisos por revisar y cobrado en el mes',
  })
  resumen() {
    return this.service.resumen();
  }

  @Get('intentos')
  @ApiOperation({
    summary:
      'Intentos de pago con PagoPlux (REVISAR = con error o sin confirmar)',
  })
  @ApiQuery({ name: 'status', required: false, enum: ESTADOS })
  @ApiQuery({ name: 'accountId', required: false, type: Number })
  intentos(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('accountId') accountId?: string,
  ) {
    return this.service.intentos({
      status: status && ESTADOS.includes(status) ? status : undefined,
      accountId: accountId ? Number(accountId) || undefined : undefined,
      page: Math.max(1, page),
      limit: Math.min(100, Math.max(1, limit)),
    });
  }

  @Get('intentos/:id')
  @ApiOperation({
    summary:
      'Detalle de un intento: avisos de Plux recibidos y pagos registrados',
  })
  intento(@Param('id', ParseIntPipe) id: number) {
    return this.service.intento(id);
  }

  @Get('avisos')
  @ApiOperation({
    summary:
      'Avisos recibidos de PagoPlux (REVISAR = sin pago, monto distinto o error)',
  })
  @ApiQuery({ name: 'result', required: false, enum: RESULTADOS })
  avisos(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('result') result?: string,
  ) {
    return this.service.avisos({
      result: result && RESULTADOS.includes(result) ? result : undefined,
      page: Math.max(1, page),
      limit: Math.min(100, Math.max(1, limit)),
    });
  }
}
