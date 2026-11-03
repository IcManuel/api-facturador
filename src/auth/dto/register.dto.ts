import { IsString, IsEmail, IsOptional, Length, MinLength, IsEnum, Equals } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType, PlanTier } from '../../entities/enums';

export class RegisterDto {
  @ApiProperty({ description: 'Nombre de la empresa o cuenta', example: 'Mi Empresa S.A.' })
  @IsString()
  accountName: string;

  @ApiProperty({ description: 'RUC de la empresa (13 dígitos)', example: '0991234567001' })
  @IsString()
  @Length(13, 13, { message: 'El RUC debe tener exactamente 13 dígitos' })
  ruc: string;

  @ApiProperty({ description: 'Email de contacto (será el email de la cuenta y del usuario admin)', example: 'admin@miempresa.com' })
  @IsEmail({}, { message: 'Ingrese un email válido' })
  email: string;

  @ApiPropertyOptional({ description: 'Teléfono de contacto' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ description: 'Nombre del usuario administrador', example: 'Juan Pérez' })
  @IsString()
  adminName: string;

  @ApiProperty({ description: 'Contraseña (mínimo 6 caracteres)', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  password: string;

  @ApiPropertyOptional({
    description: 'Tier del plan a asignar (basic, professional, enterprise, payperuse). Por defecto basic.',
    enum: PlanTier,
  })
  @IsOptional()
  @IsEnum(PlanTier)
  planTier?: PlanTier;

  @ApiPropertyOptional({
    description:
      'Tipo de cuenta: single (una empresa) o multi (varias empresas, p. ej. integradores o ERP que crean empresas por API con la llave ak_). Por defecto single.',
    enum: AccountType,
  })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;

  @ApiProperty({
    description: 'Debe ser true: acepta los términos y condiciones, incluidos los precios que se cobrarán por cada empresa.',
    example: true,
  })
  @Equals(true, { message: 'Debe aceptar los términos y condiciones para crear la cuenta.' })
  acceptTerms: boolean;
}
