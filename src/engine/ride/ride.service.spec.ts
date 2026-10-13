import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { inflateSync, deflateSync } from 'zlib';
import { RideService, RideData } from './ride.service';

/**
 * Pruebas del encabezado del RIDE.
 *
 * Regla de oro: una empresa SIN contactos genera exactamente el mismo RIDE que antes
 * de existir los contactos. La línea base (__fixtures__/ride-baseline.json) se generó
 * con el código anterior al cambio, con:
 *
 *   RIDE_BASELINE_WRITE=1 npx jest ride.service.spec
 *
 * No regenerarla salvo que se cambie el RIDE a propósito.
 */

const FIXED_NOW = new Date('2026-10-13T15:00:00.000Z');
const BASELINE_PATH = join(__dirname, '__fixtures__', 'ride-baseline.json');

/** PNG RGB sólido de w×h, generado aquí para no depender de archivos binarios. */
function makePng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x33)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LOGO = makePng(120, 60);

const LONG_MATRIZ =
  'AV. GONZALEZ SUAREZ N32-346 Y CORUÑA, EDIFICIO TORRE BLANCA, PISO 12, OFICINA 1204, ' +
  'SECTOR LA FLORESTA, JUNTO AL PARQUE ITALIA, QUITO, PICHINCHA, ECUADOR';
const LONG_SUCURSAL =
  'CALLE BOLIVAR 14-22 ENTRE SUCRE Y GARCIA MORENO, CENTRO COMERCIAL EL PASEO, LOCAL 45, ' +
  'PLANTA BAJA, RIOBAMBA, CHIMBORAZO, ECUADOR';

function baseData(
  codDoc: string,
  opts: { logo?: boolean; long?: boolean; short?: boolean } = {},
): RideData {
  const data: RideData = {
    razonSocial: opts.long
      ? 'TEAM REPARACIONES Y SERVICIO TECNICO ESPECIALIZADO DE EQUIPOS ELECTRONICOS CIA. LTDA.'
      : 'TEAM REPARACIONES',
    nombreComercial: opts.long
      ? 'SERVI TEAM - CENTRO DE REPARACIONES AUTORIZADO'
      : undefined,
    ruc: '0691234567001',
    dirMatriz: opts.long
      ? LONG_MATRIZ
      : opts.short
        ? 'Del chamburo'
        : 'AV. DANIEL LEON BORJA Y DUCHICELA',
    dirEstablecimiento: opts.long
      ? LONG_SUCURSAL
      : opts.short
        ? 'Del chamburo'
        : 'AV. DANIEL LEON BORJA Y DUCHICELA',
    obligadoContabilidad: 'NO',
    contribuyenteRimpe: opts.long ? 'CONTRIBUYENTE RÉGIMEN RIMPE' : undefined,
    contribuyenteEspecial: opts.long ? '12345' : undefined,
    agenteRetencion: opts.long ? '1' : undefined,
    codDoc,
    establecimiento: '001',
    puntoEmision: '001',
    secuencial: '000012345',
    claveAcceso: '1310202601069123456700110010010000123451234567818',
    numeroAutorizacion: '1310202601069123456700110010010000123451234567818',
    fechaAutorizacion: '13/10/2026 10:00:00',
    ambiente: '1',
    razonSocialComprador: 'JUAN PEREZ',
    identificacionComprador: '0601234567',
    fechaEmision: '13/10/2026',
    detalles: [
      {
        codigoPrincipal: 'SERV-01',
        descripcion: 'Cambio de pantalla de celular',
        cantidad: 1,
        precioUnitario: 40,
        descuento: 0,
        precioTotalSinImpuesto: 40,
        impuestos: [{ codigoPorcentaje: '4', tarifa: 15 }],
      },
    ],
    totalSinImpuestos: 40,
    totalDescuento: 0,
    importeTotal: 46,
    totalConImpuestos: [
      { codigo: '2', codigoPorcentaje: '4', baseImponible: 40, valor: 6 },
    ],
    pagos: [{ formaPago: '01', total: 46 }],
    infoAdicional: [
      { nombre: 'Email', valor: 'juan@example.com' },
      { nombre: 'RUC Proveedor', valor: '0706410164001' },
    ],
    logoBuffer: opts.logo ? LOGO : undefined,
    brandFooter: 'Hecho por Servisoftt',
  };

  if (codDoc === '04') {
    Object.assign(data, {
      codDocModificado: '01',
      numDocModificado: '001-001-000012000',
      fechaEmisionDocSustento: '01/10/2026',
      motivo: 'Devolución',
      valorModificacion: 46,
    });
  }
  if (codDoc === '05') {
    Object.assign(data, {
      codDocModificado: '01',
      numDocModificado: '001-001-000012000',
      fechaEmisionDocSustento: '01/10/2026',
      motivosND: [{ razon: 'Intereses por mora', valor: 5 }],
    });
  }
  if (codDoc === '06') {
    data.guiaRemisionData = {
      dirPartida: 'AV. DANIEL LEON BORJA',
      razonSocialTransportista: 'TRANSPORTES ANDES',
      tipoIdentificacionTransportista: '04',
      rucTransportista: '0690000000001',
      fechaIniTransporte: '13/10/2026',
      fechaFinTransporte: '14/10/2026',
      placa: 'HBA1234',
      destinatarios: [
        {
          identificacionDestinatario: '0601234567',
          razonSocialDestinatario: 'JUAN PEREZ',
          dirDestinatario: 'QUITO',
          motivoTraslado: 'Entrega de equipo reparado',
          detalles: [
            {
              codigoInterno: 'EQ-1',
              descripcion: 'Celular reparado',
              cantidad: 1,
            },
          ],
        },
      ],
    };
  }
  if (codDoc === '07') {
    data.periodoFiscal = '10/2026';
    data.impuestosRetencion = [
      {
        codigo: '1',
        codigoRetencion: '312',
        baseImponible: 40,
        porcentajeRetener: 1.75,
        valorRetenido: 0.7,
        codDocSustento: '01',
        numDocSustento: '001001000012000',
        fechaEmisionDocSustento: '01/10/2026',
      },
    ];
  }
  return data;
}

const DOC_TYPES = ['01', '03', '04', '05', '06', '07'];
const SCENARIOS = DOC_TYPES.flatMap((codDoc) =>
  [false, true].flatMap((logo) =>
    [
      { long: false, short: false },
      { long: true, short: false },
      { long: false, short: true },
    ].map((addr) => ({ codDoc, logo, ...addr })),
  ),
);
const scenarioKey = (s: {
  codDoc: string;
  logo: boolean;
  long: boolean;
  short: boolean;
}) =>
  `${s.codDoc}${s.logo ? '-logo' : ''}${s.long ? '-long' : ''}${s.short ? '-corta' : ''}`;

/** Texto dibujado en el PDF, en orden, con su posición (extraído del PDF ya generado). */
function extractText(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue; // imágenes u otros streams no comprimidos con Flate
    }
    const textRe = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm[\s\S]*?\[([^\]]*)\] TJ/g;
    let t: RegExpExecArray | null;
    while ((t = textRe.exec(content))) {
      const hex = (t[3].match(/<([0-9a-fA-F]*)>/g) || [])
        .map((h) => h.slice(1, -1))
        .join('');
      out.push(`${t[1]},${t[2]} ${Buffer.from(hex, 'hex').toString('latin1')}`);
    }
  }
  return out;
}

async function render(data: RideData) {
  const service = new RideService();
  const boxes: number[][] = [];
  const realBox = (service as any).box.bind(service);
  (service as any).box = (
    doc: any,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    boxes.push([x, y, w, h]);
    return realBox(doc, x, y, w, h);
  };
  const pdf = await service.generate(data);
  // El encabezado dibuja primero el recuadro derecho y luego el del emisor
  return { pdf, text: extractText(pdf), headerBoxes: boxes.slice(0, 2) };
}

/** Solo el encabezado (mismo drawHeader del RIDE), para medirlo sin el resto del comprobante. */
async function renderHeaderOnly(data: RideData) {
  const service = new RideService() as any;
  const boxes: number[][] = [];
  const realBox = service.box.bind(service);
  service.box = (doc: any, x: number, y: number, w: number, h: number) => {
    boxes.push([x, y, w, h]);
    return realBox(doc, x, y, w, h);
  };
  const barcode = await service.generateBarcode(data.claveAcceso);
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 28, bottom: 30, left: 30, right: 30 },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) =>
    doc.on('end', () => res(Buffer.concat(chunks))),
  );
  service.drawHeader(doc, data, 28, doc.page.width - 60, barcode);
  doc.end();
  const pdf = await done;
  return { text: extractText(pdf), headerBoxes: boxes };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('RIDE — encabezado del emisor', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
      ],
    });
  });
  afterAll(() => jest.useRealTimers());

  it('genera PDFs deterministas (base de la comparación)', async () => {
    const a = await render(baseData('01', { logo: true }));
    const b = await render(baseData('01', { logo: true }));
    expect(sha(a.pdf)).toBe(sha(b.pdf));
    expect(a.text.length).toBeGreaterThan(20);
  });

  if (process.env.RIDE_BASELINE_WRITE) {
    it('escribe la línea base con el código actual', async () => {
      const baseline: Record<string, any> = {};
      for (const s of SCENARIOS) {
        const r = await render(baseData(s.codDoc, s));
        baseline[scenarioKey(s)] = {
          sha256: sha(r.pdf),
          headerBoxes: r.headerBoxes,
          text: r.text,
        };
      }
      mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 1) + '\n');
    });
    return;
  }

  describe('regla de oro: sin contactos el RIDE es idéntico al anterior', () => {
    const baseline = existsSync(BASELINE_PATH)
      ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
      : {};

    it('la línea base cubre los 6 comprobantes, con y sin logo, direcciones de una línea, medianas y largas', () => {
      expect(Object.keys(baseline).sort()).toEqual(
        SCENARIOS.map(scenarioKey).sort(),
      );
    });

    for (const s of SCENARIOS) {
      const key = scenarioKey(s);
      for (const variant of ['sin campo', 'lista vacía'] as const) {
        it(`${key} (${variant}): mismo PDF, mismo texto, misma altura del recuadro`, async () => {
          const data = baseData(s.codDoc, s);
          if (variant === 'lista vacía') (data as any).contactosEmisor = [];
          const r = await render(data);
          expect(r.headerBoxes).toEqual(baseline[key].headerBoxes);
          expect(r.text).toEqual(baseline[key].text);
          expect(sha(r.pdf)).toBe(baseline[key].sha256);
        });
      }
    }
  });

  describe('con contactos', () => {
    const PAGE_H = 841.89;
    const CONTACTOS = [
      { nombre: 'Teléfono fijo', valor: '032967455' },
      { nombre: 'Celular', valor: '0984593623 / 0982041587' },
      { nombre: 'Correo', valor: 'servi_team@yahoo.es' },
      {
        nombre: 'Horario de atención al público en matriz',
        valor:
          'Lunes a viernes de 08:00 a 18:00 y sábados de 09:00 a 13:00, excepto feriados nacionales y locales',
      },
      {
        nombre: 'Web',
        valor:
          'https://www.teamreparaciones.com.ec/servicio-tecnico/' +
          'x'.repeat(66),
      },
      { nombre: 'WhatsApp', valor: '+593 98 459 3623' },
    ];
    const baseline = existsSync(BASELINE_PATH)
      ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
      : {};

    type Line = { x: number; y: number; s: string };
    const parse = (text: string[]): Line[] =>
      text.map((t) => {
        const sp = t.indexOf(' ');
        const [x, y] = t.slice(0, sp).split(',').map(Number);
        return { x, y, s: t.slice(sp + 1) };
      });

    for (const n of [1, 3, 6]) {
      for (const s of SCENARIOS) {
        const key = scenarioKey(s);
        it(`${key} con ${n} contacto(s): se imprimen en orden, dentro del recuadro y sin montarse`, async () => {
          const data = baseData(s.codDoc, s);
          data.contactosEmisor = CONTACTOS.slice(0, n);
          const r = await render(data); // el comprobante completo se genera sin errores
          const h = await renderHeaderOnly(data);
          expect(h.headerBoxes).toEqual(r.headerBoxes);
          const [right, left] = h.headerBoxes;
          const lines = parse(h.text);

          // Los dos recuadros del encabezado siguen alineados
          expect(left[1] + left[3]).toBeCloseTo(right[1] + right[3], 5);

          // Texto del recuadro del emisor: todo dentro del recuadro
          const leftX0 = left[0],
            leftX1 = left[0] + left[2];
          const boxTop = PAGE_H - left[1],
            boxBottom = PAGE_H - (left[1] + left[3]);
          const inLeft = lines.filter((l) => l.x >= leftX0 && l.x < leftX1);
          for (const l of inLeft) {
            expect(l.y).toBeLessThan(boxTop - 2);
            expect(l.y).toBeGreaterThan(boxBottom + 1);
          }

          // Columna de etiquetas (x = 38) y columna de valores (x >= 110)
          const labelCol = inLeft.filter(
            (l) => Math.abs(l.x - (leftX0 + 8)) < 1,
          );
          const valueCol = inLeft.filter((l) => l.x >= leftX0 + 80);

          // Ninguna línea se monta sobre otra dentro de su columna
          for (const col of [labelCol, valueCol]) {
            const sorted = [...col].sort((a, b) => b.y - a.y);
            for (let i = 1; i < sorted.length; i++) {
              expect(sorted[i - 1].y - sorted[i].y).toBeGreaterThanOrEqual(8);
            }
          }

          // Filas "Etiqueta: valor". Dentro de una fila el valor avanza de a una línea (9,25);
          // entre filas hay más espacio. Así se separan aunque etiqueta o valor ocupen varias líneas.
          const valueYs = [...new Set(valueCol.map((l) => l.y))].sort(
            (a, b) => b - a,
          );
          const starts = valueYs.filter(
            (y, i) => i === 0 || valueYs[i - 1] - y > 9.6,
          );
          const rows = starts.map((y, i) => {
            const next = i + 1 < starts.length ? starts[i + 1] : -Infinity;
            const inRow = (l: Line) => l.y <= y + 0.01 && l.y > next + 0.01;
            return {
              label: labelCol
                .filter(inRow)
                .map((l) => l.s)
                .join(' '),
              value: valueCol
                .filter(inRow)
                .map((l) => l.s)
                .join(' '),
            };
          });
          const squash = (t: string) => t.replace(/\s+/g, '');

          // Los contactos son exactamente las filas que siguen a la última dirección, en orden
          const lastAddr = rows
            .map((r) => r.label)
            .reduce((acc, l, i) => (l.startsWith('Direccion') ? i : acc), -1);
          expect(lastAddr).toBeGreaterThanOrEqual(0);
          const printed = rows.slice(lastAddr + 1, lastAddr + 1 + n);
          expect(printed.map((r) => squash(r.label))).toEqual(
            data.contactosEmisor.map((c) => squash(`${c.nombre}:`)),
          );
          expect(printed.map((r) => squash(r.value))).toEqual(
            data.contactosEmisor.map((c) => squash(c.valor)),
          );

          // Aire visible antes del primer contacto: la etiqueta de la dirección ocupa dos
          // líneas ("Direccion" / "Matriz:") y no debe quedar pegada a la etiqueta del contacto
          const firstContactY = starts[lastAddr + 1];
          const above = labelCol
            .filter((l) => l.y > firstContactY + 0.01)
            .map((l) => l.y);
          expect(Math.min(...above) - firstContactY).toBeGreaterThanOrEqual(11);

          // Y después viene lo de siempre: Contribuyente Especial u OBLIGADO A LLEVAR CONTABILIDAD
          expect(rows[lastAddr + 1 + n].label).toMatch(
            /^(Contribuyente Especial|OBLIGADO A LLEVAR CONTABILIDAD)/,
          );

          // Con contactos el recuadro no puede ser más bajo que sin ellos
          expect(left[3]).toBeGreaterThanOrEqual(
            baseline[key].headerBoxes[1][3],
          );
          expect(sha(r.pdf)).not.toBe(baseline[key].sha256);
        });
      }
    }
  });

  describe('Informacion Adicional: un valor de varias líneas no se monta sobre la fila siguiente', () => {
    const PAGE_H = 841.89;
    for (const codDoc of DOC_TYPES) {
      it(`comprobante ${codDoc}`, async () => {
        const data = baseData(codDoc);
        data.infoAdicional = [
          { nombre: 'RUC Proveedor', valor: '0706410164001' },
          {
            nombre: 'Direccion',
            valor:
              'CUENCA. NARANCAY. CALLE DE 3 EN RAYA Y VILLALOBOS, JUNTO A LA ESCUELA FISCAL MIXTA, CASA ESQUINERA DE DOS PISOS, ' +
              'PORTON NEGRO, A DOS CUADRAS DE LA PANAMERICANA SUR, FRENTE A LA TIENDA DE ABARROTES DON LUCHO, SECTOR LA FLORIDA',
          },
          { nombre: 'Concepto', valor: 'ANTICIPO DESARROLLO MAELIA' },
        ];
        const service = new RideService() as any;
        const boxes: number[][] = [];
        const realBox = service.box.bind(service);
        service.box = (
          doc: any,
          x: number,
          y: number,
          w: number,
          h: number,
        ) => {
          boxes.push([x, y, w, h]);
          return realBox(doc, x, y, w, h);
        };
        const lines = extractText(await service.generate(data)).map((t) => {
          const sp = t.indexOf(' ');
          const [x, y] = t.slice(0, sp).split(',').map(Number);
          return { x, y, s: t.slice(sp + 1) };
        });

        const title = lines.find((l) => l.s === 'Informacion Adicional')!;
        const dirValue = lines.filter(
          (l) =>
            Math.abs(l.x - (title.x + 65)) < 1 &&
            l.y < title.y &&
            l.y > title.y - 80 &&
            !/^0706|^ANTICIPO/.test(l.s),
        );
        const concepto = lines.find((l) => l.s === 'Concepto:')!;
        expect(dirValue.length).toBeGreaterThanOrEqual(2); // la dirección sí ocupa varias líneas
        const lastDirLineY = Math.min(...dirValue.map((l) => l.y));
        expect(lastDirLineY - concepto.y).toBeGreaterThanOrEqual(8);

        // la última fila sigue dentro del recuadro
        const box = boxes.find(
          (b) => Math.abs(PAGE_H - b[1] - title.y) < 20 && b[0] < title.x,
        )!;
        expect(concepto.y).toBeGreaterThan(PAGE_H - (box[1] + box[3]) + 1);
      });
    }
  });

  describe('textos largos: ninguna fila se corta ni se monta (todas las tablas y recuadros)', () => {
    const PAGE_H = 841.89;
    const LARGO =
      'COMERCIALIZADORA E IMPORTADORA DE REPUESTOS Y ACCESORIOS PARA EQUIPOS ELECTRONICOS Y DE TELECOMUNICACIONES DEL AUSTRO CIA. LTDA.';

    function longData(codDoc: string): RideData {
      const data = baseData(codDoc, { short: true });
      data.razonSocialComprador = LARGO;
      data.pagos = [
        { formaPago: '20', total: 30, plazo: 30, unidadTiempo: 'dias' },
        { formaPago: '01', total: 16 },
      ];
      data.motivo =
        'Devolución parcial de mercadería por fallas de fábrica detectadas en la revisión técnica posterior a la entrega del pedido completo';
      if (codDoc === '07') {
        data.impuestosRetencion![0].codDocSustento = '03'; // LIQUIDACION DE COMPRAS
      }
      if (codDoc === '06') {
        const gr = data.guiaRemisionData!;
        gr.dirPartida =
          'AV. DANIEL LEON BORJA Y DUCHICELA, JUNTO AL CENTRO COMERCIAL PASEO SHOPPING, BODEGA 14, RIOBAMBA, CHIMBORAZO';
        gr.razonSocialTransportista = LARGO;
        const d = gr.destinatarios[0];
        d.razonSocialDestinatario = LARGO;
        d.dirDestinatario =
          'CALLE BOLIVAR 14-22 ENTRE SUCRE Y GARCIA MORENO, CENTRO COMERCIAL EL PASEO, LOCAL 45, PLANTA BAJA, QUITO';
        d.motivoTraslado =
          'Entrega de equipos reparados y devolución de repuestos sobrantes al cliente, según orden de servicio';
        d.ruta =
          'Riobamba - Ambato - Latacunga - Quito, por la Panamericana Norte con parada en bodega de Ambato';
        d.codDocSustento = '01';
        d.numDocSustento = '001-001-000012000';
        d.detalles[0].codigoInterno = 'REP-PANTALLA-SAMSUNG-A54-ORIG';
      }
      return data;
    }

    for (const codDoc of DOC_TYPES) {
      it(`comprobante ${codDoc}: todas las líneas dentro de su recuadro y sin montarse`, async () => {
        const service = new RideService() as any;
        const boxes: number[][] = [];
        const realBox = service.box.bind(service);
        service.box = (
          doc: any,
          x: number,
          y: number,
          w: number,
          h: number,
        ) => {
          boxes.push([x, y, w, h]);
          return realBox(doc, x, y, w, h);
        };
        const lines = extractText(await service.generate(longData(codDoc)))
          .map((t) => {
            const sp = t.indexOf(' ');
            const [x, y] = t.slice(0, sp).split(',').map(Number);
            return { x, y, s: t.slice(sp + 1) };
          })
          .filter((l) => l.y > 30); // pie de marca, fuera de los recuadros

        // Cada línea pertenece al recuadro más cercano por encima de ella y queda dentro
        for (const l of lines) {
          const owners = boxes
            .filter(([bx, , bw]) => l.x >= bx - 0.5 && l.x < bx + bw)
            .filter(([, by]) => PAGE_H - by >= l.y)
            .sort((a, b) => PAGE_H - a[1] - (PAGE_H - b[1]));
          const owner = owners[0];
          expect(owner).toBeDefined();
          const bottom = PAGE_H - (owner[1] + owner[3]);
          if (!(l.y > bottom + 1)) {
            throw new Error(
              `"${l.s}" (y=${l.y}) se sale de su recuadro (borde inferior y=${bottom.toFixed(2)})`,
            );
          }
        }

        // En una misma columna, dos líneas distintas no pueden estar a menos de 7 puntos
        const byX = new Map<number, typeof lines>();
        for (const l of lines) {
          const k = Math.round(l.x * 10) / 10;
          byX.set(k, [...(byX.get(k) || []), l]);
        }
        for (const col of byX.values()) {
          const sorted = [...col].sort((a, b) => b.y - a.y);
          for (let i = 1; i < sorted.length; i++) {
            const dy = sorted[i - 1].y - sorted[i].y;
            if (dy < 7) {
              throw new Error(
                `"${sorted[i - 1].s}" y "${sorted[i].s}" se montan (separación ${dy.toFixed(2)})`,
              );
            }
          }
        }

        // El texto largo se imprimió completo (no quedó cortado ni tapado)
        const all = lines
          .map((l) => l.s)
          .join(' ')
          .replace(/\s+/g, '');
        // las retenciones y las guías no tienen forma de pago
        if (!['06', '07'].includes(codDoc)) {
          expect(all).toContain('20OTROSCONUTILIZACIONDELSISTEMAFINANCIERO');
        }
        expect(all).toContain(LARGO.replace(/\s+/g, ''));
      });
    }
  });
});
