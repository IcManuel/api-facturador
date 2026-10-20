import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PagosService } from './pagos.service';
import { AvisosService } from './avisos.service';
import { CrearPagoDto } from './dto/crear-pago.dto';
import { respuestaHook } from './pagos.util';

@ApiTags('Client - Pagos')
@ApiBearerAuth()
@Controller('client/billing/pago')
export class ClientPagosController {
  constructor(private readonly pagos: PagosService) {}

  @Get('estado')
  @ApiOperation({
    summary: 'Estado de cobro de la cuenta: deuda, bloqueo y fechas',
  })
  estado(@CurrentUser('accountId') accountId: number) {
    return this.pagos.estado(accountId);
  }

  @Post()
  @ApiOperation({
    summary: 'Iniciar un pago con PagoPlux (el monto lo pone el servidor)',
  })
  crear(
    @CurrentUser('accountId') accountId: number,
    @CurrentUser('id') userId: number,
    @Body() dto: CrearPagoDto,
  ) {
    return this.pagos.crear(accountId, userId, dto);
  }

  @Post(':id/reportar')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'El modal de PagoPlux aprobó: queda en confirmación (no activa nada)',
  })
  reportar(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.pagos.reportar(accountId, id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Estado de un pago (lo consulta la pantalla de resultado)',
  })
  estadoPago(
    @CurrentUser('accountId') accountId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.pagos.estadoPago(accountId, id);
  }
}

/** Aviso de PagoPlux (reenviado por Mila o directo de Plux). Público: se autentica por firma. */
@Controller('pagos/plux')
export class PagosHookController {
  private readonly logger = new Logger(PagosHookController.name);

  constructor(private readonly avisos: AvisosService) {}

  @Public()
  @Post('aviso')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async aviso(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
  ) {
    const ip = req.ip ?? null;
    const source = this.avisos.autenticar(req.rawBody, req.headers, ip);
    if (!source) {
      this.logger.warn(
        `Aviso de pago rechazado (sin firma o credenciales válidas) desde ${ip}`,
      );
      throw new UnauthorizedException();
    }
    const resultado = await this.avisos.recibir(body ?? {}, source, ip);
    this.logger.log(`Aviso de pago (${source}): ${resultado}`);
    return respuestaHook();
  }
}
