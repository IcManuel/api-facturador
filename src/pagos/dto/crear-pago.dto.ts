import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CrearPagoDto {
  @ApiProperty({
    description: 'Cédula o RUC de quien paga (PagoPlux la valida)',
    example: '0102030405',
  })
  @IsString()
  @MaxLength(13)
  identificacion: string;

  @ApiProperty({ description: 'Celular de quien paga', example: '0991234567' })
  @IsString()
  @MaxLength(20)
  telefono: string;

  @ApiProperty({
    description: 'Dirección de quien paga',
    example: 'Av. Amazonas N39-123, Quito',
  })
  @IsString()
  @MaxLength(200)
  direccion: string;

  @ApiPropertyOptional({
    description: 'Solo al activar una cuenta de una empresa: plan elegido',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  planId?: number;
}
