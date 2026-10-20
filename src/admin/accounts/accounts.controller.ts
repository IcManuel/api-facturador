import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateAccountUserDto } from './dto/create-account-user.dto';
import { UpdateAccountUserDto } from './dto/update-account-user.dto';
import { ExtendTrialDto } from './dto/extend-trial.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Cuentas')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/accounts')
export class AccountsController {
  constructor(private readonly service: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar cuentas con paginación' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'search', required: false })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.service.findAll(page, limit, search);
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Reporte de actividad por tenant',
    description: 'Lista todas las cuentas con su último uso del sistema y número de documentos emitidos. Ordenado por última actividad (más reciente primero).',
  })
  getActivityReport() {
    return this.service.getActivityReport();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de cuenta' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear cuenta' })
  create(@Body() dto: CreateAccountDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar cuenta' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.service.update(id, dto);
  }

  @Get(':id/users')
  @ApiOperation({ summary: 'Listar usuarios de la cuenta' })
  findUsers(@Param('id', ParseIntPipe) id: number) {
    return this.service.findUsers(id);
  }

  @Post(':id/users')
  @ApiOperation({ summary: 'Crear usuario en la cuenta' })
  createUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateAccountUserDto,
  ) {
    return this.service.createUser(id, dto);
  }

  @Patch(':accId/users/:userId')
  @ApiOperation({ summary: 'Actualizar usuario de la cuenta' })
  updateUser(
    @Param('accId', ParseIntPipe) accId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateAccountUserDto,
  ) {
    return this.service.updateUser(accId, userId, dto);
  }

  @Delete(':accId/users/:userId')
  @ApiOperation({ summary: 'Desactivar usuario de la cuenta' })
  removeUser(
    @Param('accId', ParseIntPipe) accId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.removeUser(accId, userId);
  }

  // ── Account Activation ──

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activar cuenta (convertir de trial a activa)' })
  activate(@Param('id', ParseIntPipe) id: number) {
    return this.service.activate(id);
  }

  @Patch(':id/trial')
  @ApiOperation({ summary: 'Extender el período de prueba de la cuenta N días' })
  extendTrial(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExtendTrialDto,
  ) {
    return this.service.extendTrial(id, dto.days);
  }

  // ── Account API Key ──

  @Post(':id/api-key')
  @ApiOperation({ summary: 'Generar o regenerar API key de cuenta' })
  generateApiKey(@Param('id', ParseIntPipe) id: number) {
    return this.service.generateApiKey(id);
  }

  @Delete(':id/api-key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revocar API key de cuenta' })
  revokeApiKey(@Param('id', ParseIntPipe) id: number) {
    return this.service.revokeApiKey(id);
  }
}
