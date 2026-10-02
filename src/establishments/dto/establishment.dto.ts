import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, MaxLength, Matches } from 'class-validator';

export class CreateEstablishmentDto {
  @ApiProperty({ description: 'Código del establecimiento (3 dígitos)', example: '002' })
  @IsString()
  @Length(3, 3)
  @Matches(/^\d{3}$/, { message: 'code debe ser numérico de 3 dígitos (ej: "002")' })
  code: string;

  @ApiPropertyOptional({ description: 'Nombre o referencia de la sucursal', example: 'Sucursal Norte' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Dirección del establecimiento (sale en el RIDE)', example: 'Av. 10 de Agosto N34-56, Quito' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}

export class UpdateEstablishmentDto {
  @ApiPropertyOptional({ description: 'Nombre o referencia de la sucursal' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Dirección del establecimiento' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ description: 'Activo. Un establecimiento inactivo no puede emitir.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
