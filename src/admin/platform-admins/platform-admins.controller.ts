import { Controller, Get, Post, Patch, Delete, Param, Body, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PlatformAdminsService } from './platform-admins.service';
import { CreatePlatformAdminDto } from './dto/create-platform-admin.dto';
import { UpdatePlatformAdminDto } from './dto/update-platform-admin.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { PLATFORM_ADMIN } from '../../common/guards/roles.guard';

@ApiTags('Admin - Platform Admins')
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller('admin/platform-admins')
export class PlatformAdminsController {
  constructor(private readonly service: PlatformAdminsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar administradores de plataforma' })
  findAll() {
    return this.service.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Crear administrador de plataforma' })
  create(@Body() dto: CreatePlatformAdminDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar administrador de plataforma' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePlatformAdminDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar administrador de plataforma' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
