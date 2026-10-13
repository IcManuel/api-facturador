import { Allow } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RideContactoDto {
  @ApiProperty({ example: 'Celular', maxLength: 40 })
  nombre: string;

  @ApiProperty({ example: '0984593623 / 0982041587', maxLength: 120 })
  valor: string;
}

export class UpdateRideContactosDto {
  // La validación detallada (máximo 6, longitudes, limpieza) la hace normalizeRideContactos,
  // para devolver un mensaje que diga qué contacto y qué campo está mal.
  @ApiProperty({
    type: [RideContactoDto],
    maxItems: 6,
    description:
      'Lista completa de contactos. Reemplaza la anterior. Lista vacía = quitar los contactos.',
    example: [
      { nombre: 'Teléfono fijo', valor: '032967455' },
      { nombre: 'Celular', valor: '0984593623 / 0982041587' },
      { nombre: 'Correo', valor: 'servi_team@yahoo.es' },
    ],
  })
  @Allow()
  contactos: unknown;
}
