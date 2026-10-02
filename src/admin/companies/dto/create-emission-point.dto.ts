import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEmissionPointDto {
  @ApiProperty({
    description: 'Código del punto de emisión (3 dígitos)',
    minLength: 3,
    maxLength: 3,
  })
  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  code: string;

  @ApiPropertyOptional({ description: 'Descripción del punto de emisión' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Establecimiento al que pertenece (3 dígitos). Si no se envía, el principal de la empresa.',
    example: '002',
  })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  establecimiento?: string;
}
