import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCompanyInfoDto {
  @ApiPropertyOptional({ description: 'Razón social', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  name?: string;

  @ApiPropertyOptional({ description: 'Nombre comercial', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  tradeName?: string;

  @ApiPropertyOptional({ description: 'Correo electrónico de la empresa' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Teléfono', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ description: 'Dirección principal' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description:
      'Código de establecimiento (3 dígitos). Los comprobantes ya emitidos conservan su establecimiento; ' +
      'los nuevos usan este y arrancan una serie de secuenciales propia para el establecimiento.',
    example: '002',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}$/, { message: 'establishment debe ser numérico de 3 dígitos' })
  establishment?: string;
}
