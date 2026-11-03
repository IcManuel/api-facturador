import { Controller, Get, Patch, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ClientProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ConvertToMultiDto } from './dto/convert-to-multi.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Client - Profile')
@ApiBearerAuth()
@Controller('client/profile')
export class ClientProfileController {
  constructor(private readonly profileService: ClientProfileService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener perfil de la cuenta' })
  getProfile(@CurrentUser('accountId') accountId: number) {
    return this.profileService.getProfile(accountId);
  }

  @Patch()
  @ApiOperation({ summary: 'Actualizar perfil de la cuenta' })
  updateProfile(
    @CurrentUser('accountId') accountId: number,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.updateProfile(accountId, dto);
  }

  @Post('multiempresa')
  @ApiOperation({
    summary: 'Cambiar la cuenta a multiempresa',
    description:
      'Solo el administrador de la cuenta. Es de una sola vía: volver a empresa única lo hace soporte, y solo si la cuenta tiene una empresa.',
  })
  convertToMulti(
    @CurrentUser('accountId') accountId: number,
    @CurrentUser('id') userId: number,
    @Body() _dto: ConvertToMultiDto,
  ) {
    return this.profileService.convertToMulti(accountId, userId);
  }
}
