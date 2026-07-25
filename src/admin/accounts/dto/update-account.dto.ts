import { OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateAccountDto } from './create-account.dto';
import { AccountStatus } from '../../../entities/enums';

export class UpdateAccountDto extends PartialType(
  OmitType(CreateAccountDto, ['adminName', 'adminEmail', 'adminPassword', 'warningMessage'] as const),
) {
  @ApiPropertyOptional({ description: 'Activar o desactivar la cuenta' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Estado de la cuenta', enum: AccountStatus })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional({ description: 'Mensaje de advertencia (null para eliminar)', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  warningMessage?: string | null;

  @ApiPropertyOptional({
    description: 'Pie de página del RIDE (branding por cuenta), ej. "Hecho por ...". null o vacío = no imprime nada.',
    nullable: true,
  })
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  rideFooter?: string | null;

  @ApiPropertyOptional({
    description: 'Marcar cuenta como interna/propia — se excluye del billing y de todas las notificaciones automáticas.',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}
