import { BadRequestException } from '@nestjs/common';

/** Dato de contacto del emisor que se imprime en el RIDE, debajo de la dirección. */
export interface RideContacto {
  nombre: string;
  valor: string;
}

export const RIDE_CONTACTOS_MAX = 6;
export const RIDE_CONTACTO_NOMBRE_MAX = 40;
export const RIDE_CONTACTO_VALOR_MAX = 120;

/** Quita saltos de línea, tabulaciones y espacios repetidos. */
export function cleanRideText(value: string): string {
  return value
    .replace(/[\r\n\t\f\v]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const length = (s: string) => [...s].length;

/**
 * Valida y limpia la lista que envía el cliente. Devuelve la lista lista para guardar;
 * una lista vacía significa "sin contactos". Lanza 400 con un mensaje que indica
 * exactamente qué contacto y qué campo está mal.
 */
export function normalizeRideContactos(input: unknown): RideContacto[] {
  if (input === undefined || input === null) {
    throw new BadRequestException(
      'Envíe "contactos" con la lista de contactos. Para quitarlos, envíe una lista vacía: {"contactos": []}.',
    );
  }
  if (!Array.isArray(input)) {
    throw new BadRequestException(
      '"contactos" debe ser una lista. Ejemplo: {"contactos": [{"nombre": "Celular", "valor": "0984593623"}]}.',
    );
  }
  if (input.length > RIDE_CONTACTOS_MAX) {
    throw new BadRequestException(
      `Se permiten máximo ${RIDE_CONTACTOS_MAX} contactos; se recibieron ${input.length}.`,
    );
  }

  return input.map((item, i) => {
    const where = `contactos[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestException(
        `${where} debe ser un objeto con "nombre" y "valor".`,
      );
    }
    const extra = Object.keys(item).filter(
      (k) => k !== 'nombre' && k !== 'valor',
    );
    if (extra.length) {
      throw new BadRequestException(
        `${where} solo admite "nombre" y "valor"; sobra: ${extra.map((k) => `"${k}"`).join(', ')}.`,
      );
    }

    const field = (key: 'nombre' | 'valor', max: number): string => {
      const raw = (item as Record<string, unknown>)[key];
      if (typeof raw !== 'string') {
        throw new BadRequestException(
          `${where}.${key} es obligatorio y debe ser texto.`,
        );
      }
      const clean = cleanRideText(raw);
      if (!clean) {
        throw new BadRequestException(`${where}.${key} no puede estar vacío.`);
      }
      if (length(clean) > max) {
        throw new BadRequestException(
          `${where}.${key} admite máximo ${max} caracteres; tiene ${length(clean)}.`,
        );
      }
      return clean;
    };

    return {
      nombre: field('nombre', RIDE_CONTACTO_NOMBRE_MAX),
      valor: field('valor', RIDE_CONTACTO_VALOR_MAX),
    };
  });
}

/**
 * Lectura tolerante de lo guardado en la base: descarta entradas mal formadas en vez de
 * romper la generación del RIDE.
 */
export function storedRideContactos(value: unknown): RideContacto[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Partial<Record<keyof RideContacto, unknown>> | null>)
    .filter(
      (c): c is RideContacto =>
        !!c && typeof c.nombre === 'string' && typeof c.valor === 'string',
    )
    .map((c) => ({
      nombre: cleanRideText(c.nombre),
      valor: cleanRideText(c.valor),
    }))
    .filter((c) => c.nombre && c.valor)
    .slice(0, RIDE_CONTACTOS_MAX);
}
