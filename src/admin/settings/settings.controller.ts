import {
  Controller,
  Get,
  Patch,
  Body,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-setting.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Configuración')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar configuraciones de plataforma' })
  findAll() {
    return this.service.findAll();
  }

  @Patch()
  @ApiOperation({ summary: 'Actualizar configuraciones en lote' })
  update(
    @Body() dto: UpdateSettingsDto,
    @CurrentUser('id') adminId: number,
  ) {
    return this.service.updateBatch(dto.settings, adminId);
  }
}
