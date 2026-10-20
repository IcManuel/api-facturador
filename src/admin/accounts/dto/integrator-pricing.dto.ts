import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TramoDto {
  @ApiProperty({
    description:
      'Hasta cuántas empresas activas aplica (null = de ahí en adelante)',
    nullable: true,
    example: 20,
  })
  @IsOptional()
  @IsInt({ message: 'El límite de cada tramo debe ser un número entero' })
  @Min(1, { message: 'El límite de cada tramo debe ser al menos 1' })
  hasta: number | null;

  @ApiProperty({
    description: 'Precio por empresa activa, con IVA incluido',
    example: 3,
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio debe tener como máximo 2 decimales' },
  )
  @Min(0)
  @Max(1000)
  precio: number;
}

export class IntegratorPricingDto {
  @ApiProperty({ type: [TramoDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Agregue al menos un tramo' })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TramoDto)
  tramos: TramoDto[];

  @ApiProperty({
    description:
      'Valor por documento autorizado en producción, con IVA incluido',
    example: 0.05,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(10)
  porDocumento: number;
}
