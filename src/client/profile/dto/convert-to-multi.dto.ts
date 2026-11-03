import { Equals } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConvertToMultiDto {
  @ApiProperty({
    description: 'Debe ser true: acepta que cada empresa que cree se cobra por separado a la cuenta, según los términos y condiciones.',
    example: true,
  })
  @Equals(true, { message: 'Debe aceptar los términos y condiciones para cambiar a multiempresa.' })
  acceptTerms: boolean;
}
