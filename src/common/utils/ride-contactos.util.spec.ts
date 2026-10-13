import { BadRequestException } from '@nestjs/common';
import {
  normalizeRideContactos,
  storedRideContactos,
  cleanRideText,
} from './ride-contactos.util';

const msg = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error('no lanzó error');
};

describe('normalizeRideContactos', () => {
  it('acepta el ejemplo de TEAM REPARACIONES tal cual', () => {
    const input = [
      { nombre: 'Teléfono fijo', valor: '032967455' },
      { nombre: 'Celular', valor: '0984593623 / 0982041587' },
      { nombre: 'Correo', valor: 'servi_team@yahoo.es' },
    ];
    expect(normalizeRideContactos(input)).toEqual(input);
  });

  it('limpia saltos de línea, tabulaciones y espacios repetidos', () => {
    expect(
      normalizeRideContactos([
        { nombre: '  Celular\r\n ', valor: '0984593623\n/\t\t0982041587  ' },
      ]),
    ).toEqual([{ nombre: 'Celular', valor: '0984593623 / 0982041587' }]);
  });

  it('lista vacía = quitar contactos', () => {
    expect(normalizeRideContactos([])).toEqual([]);
  });

  it('respeta los límites exactos y cuenta caracteres, no bytes', () => {
    const nombre = 'ñ'.repeat(40),
      valor = 'é'.repeat(120);
    expect(normalizeRideContactos([{ nombre, valor }])).toEqual([
      { nombre, valor },
    ]);
    expect(
      normalizeRideContactos(
        Array.from({ length: 6 }, () => ({ nombre: 'a', valor: 'b' })),
      ),
    ).toHaveLength(6);
  });

  it.each([
    [undefined, 'Envíe "contactos"'],
    [null, 'Envíe "contactos"'],
    ['Celular: 0984', '"contactos" debe ser una lista'],
    [{ nombre: 'x', valor: 'y' }, '"contactos" debe ser una lista'],
    [
      Array.from({ length: 7 }, () => ({ nombre: 'a', valor: 'b' })),
      'máximo 6 contactos; se recibieron 7',
    ],
    [['texto'], 'contactos[0] debe ser un objeto'],
    [
      [
        { nombre: 'a', valor: 'b' },
        { nombre: 'a', valor: 'b', tipo: 'x' },
      ],
      'contactos[1] solo admite "nombre" y "valor"; sobra: "tipo"',
    ],
    [[{ valor: 'b' }], 'contactos[0].nombre es obligatorio'],
    [
      [{ nombre: 'a', valor: 984593623 }],
      'contactos[0].valor es obligatorio y debe ser texto',
    ],
    [
      [{ nombre: ' \r\n ', valor: 'b' }],
      'contactos[0].nombre no puede estar vacío',
    ],
    [
      [{ nombre: 'a'.repeat(41), valor: 'b' }],
      'contactos[0].nombre admite máximo 40 caracteres; tiene 41',
    ],
    [
      [{ nombre: 'a', valor: 'b'.repeat(121) }],
      'contactos[0].valor admite máximo 120 caracteres; tiene 121',
    ],
  ])('rechaza %j con un mensaje claro', (input, expected) => {
    expect(msg(() => normalizeRideContactos(input))).toContain(expected);
  });

  it('el largo se mide después de limpiar', () => {
    expect(
      normalizeRideContactos([
        { nombre: 'a'.repeat(40) + '   \n', valor: 'b' },
      ])[0].nombre,
    ).toHaveLength(40);
  });
});

describe('storedRideContactos', () => {
  it('lee lo guardado y descarta entradas dañadas sin romper el RIDE', () => {
    expect(storedRideContactos(null)).toEqual([]);
    expect(storedRideContactos('x')).toEqual([]);
    expect(
      storedRideContactos([
        { nombre: 'Celular', valor: '0984' },
        { nombre: 1 },
        null,
        { nombre: ' ', valor: 'x' },
      ]),
    ).toEqual([{ nombre: 'Celular', valor: '0984' }]);
  });
});

describe('cleanRideText', () => {
  it('deja una sola línea', () =>
    expect(cleanRideText('a\r\n\r\nb   c')).toBe('a b c'));
});
