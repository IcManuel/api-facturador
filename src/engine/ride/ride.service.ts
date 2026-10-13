import { Injectable, Logger } from '@nestjs/common';
import PDFDocument = require('pdfkit');
import bwipjs = require('bwip-js');

const SRI_PAYMENT_METHODS: Record<string, string> = {
  '01': 'SIN UTILIZACION DEL SISTEMA FINANCIERO',
  '15': 'COMPENSACION DE DEUDAS',
  '16': 'TARJETA DE DEBITO',
  '17': 'DINERO ELECTRONICO',
  '18': 'TARJETA PREPAGO',
  '19': 'TARJETA DE CREDITO',
  '20': 'OTROS CON UTILIZACION DEL SISTEMA FINANCIERO',
  '21': 'ENDOSO DE TITULOS',
};

const IVA_RATE_LABELS: Record<string, string> = {
  '0': '0%',
  '2': '12%',
  '3': '14%',
  '4': '15%',
  '6': 'No obj.',
  '7': 'Exento',
  '8': 'Diferenciado',
};

const DOC_TYPE_LABELS: Record<string, string> = {
  '01': 'FACTURA',
  '03': 'LIQUIDACION DE COMPRAS',
  '04': 'NOTA DE CREDITO',
  '05': 'NOTA DE DEBITO',
  '06': 'GUIA DE REMISION',
  '07': 'COMPROBANTE DE RETENCION',
};

const RETENTION_TAX_LABELS: Record<string, string> = {
  '1': 'RENTA',
  '2': 'IVA',
  '6': 'ISD',
};

const DOC_SUSTENTO_LABELS: Record<string, string> = {
  '01': 'FACTURA',
  '02': 'NOTA DE VENTA',
  '03': 'LIQUIDACION DE COMPRAS',
  '04': 'NOTA DE CREDITO',
  '05': 'NOTA DE DEBITO',
  '06': 'GUIA DE REMISION',
  '07': 'COMPROBANTE DE RETENCION',
};

export interface RideData {
  // Issuer
  razonSocial: string;
  nombreComercial?: string;
  ruc: string;
  dirMatriz: string;
  dirEstablecimiento?: string;
  obligadoContabilidad: string;
  contribuyenteRimpe?: string;
  contribuyenteEspecial?: string;
  agenteRetencion?: string;
  /** Contactos del emisor (teléfonos, correo...). Se imprimen bajo la dirección. Solo RIDE. */
  contactosEmisor?: { nombre: string; valor: string }[];

  // Document
  codDoc: string;
  establecimiento: string;
  puntoEmision: string;
  secuencial: string;
  claveAcceso: string;
  numeroAutorizacion: string;
  fechaAutorizacion: string;
  ambiente: string;

  // Buyer
  razonSocialComprador: string;
  identificacionComprador: string;
  fechaEmision: string;

  // Details
  detalles: {
    codigoPrincipal: string;
    descripcion: string;
    cantidad: number;
    precioUnitario: number;
    descuento: number;
    precioTotalSinImpuesto: number;
    impuestos: { codigoPorcentaje: string; tarifa: number }[];
  }[];

  // Totals
  totalSinImpuestos: number;
  totalDescuento: number;
  importeTotal: number;
  totalConImpuestos: {
    codigo: string;
    codigoPorcentaje: string;
    baseImponible: number;
    valor: number;
  }[];

  // Payments
  pagos: {
    formaPago: string;
    total: number;
    plazo?: number;
    unidadTiempo?: string;
  }[];

  // Info adicional
  infoAdicional?: { nombre: string; valor: string }[];

  // Logo (optional, Buffer from S3)
  logoBuffer?: Buffer;

  // Pie de página configurable a nivel de cuenta (branding), ej. "Hecho por ..."
  brandFooter?: string;

  // ── Nota de Crédito-specific fields (codDoc=04) ──
  codDocModificado?: string;    // '01'=Factura, etc.
  numDocModificado?: string;    // 'NNN-NNN-NNNNNNNNN'
  fechaEmisionDocSustento?: string; // DD/MM/AAAA
  motivo?: string;
  valorModificacion?: number;

  // ── Nota de Débito-specific fields (codDoc=05) ──
  motivosND?: { razon: string; valor: number }[];

  // ── Guía de Remisión-specific fields (codDoc=06) ──
  guiaRemisionData?: {
    dirPartida: string;
    razonSocialTransportista: string;
    tipoIdentificacionTransportista: string;
    rucTransportista: string;
    fechaIniTransporte: string;
    fechaFinTransporte: string;
    placa: string;
    destinatarios: {
      identificacionDestinatario: string;
      razonSocialDestinatario: string;
      dirDestinatario: string;
      motivoTraslado: string;
      codDocSustento?: string;
      numDocSustento?: string;
      fechaEmisionDocSustento?: string;
      ruta?: string;
      detalles: {
        codigoInterno?: string;
        descripcion: string;
        cantidad: number;
      }[];
    }[];
  };

  // ── Retención-specific fields (codDoc=07) ──
  periodoFiscal?: string; // MM/AAAA
  impuestosRetencion?: {
    codigo: string;           // 1=Renta, 2=IVA, 6=ISD
    codigoRetencion: string;
    baseImponible: number;
    porcentajeRetener: number;
    valorRetenido: number;
    codDocSustento: string;
    numDocSustento: string;
    fechaEmisionDocSustento: string;
  }[];
}

// ── Layout constants ──
const PAGE_ML = 30;
const PAGE_MR = 30;
const PAGE_MT = 28;
const FONT_NORMAL = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

@Injectable()
export class RideService {
  private readonly logger = new Logger(RideService.name);

  async generate(data: RideData): Promise<Buffer> {
    const barcodeBuffer = await this.generateBarcode(data.claveAcceso);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: PAGE_MT, bottom: 30, left: PAGE_ML, right: PAGE_MR },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        const pw = doc.page.width - PAGE_ML - PAGE_MR; // usable page width
        let y = PAGE_MT;

        y = this.drawHeader(doc, data, y, pw, barcodeBuffer);

        if (data.codDoc === '07') {
          // Retención body
          y = this.drawRetencionBuyerInfo(doc, data, y, pw);
          y = this.drawRetencionTable(doc, data, y, pw);
          y = this.drawRetencionFooter(doc, data, y, pw);
        } else if (data.codDoc === '04') {
          // Nota de Crédito body
          y = this.drawNotaCreditoBuyerInfo(doc, data, y, pw);
          y = this.drawDetailTable(doc, data, y, pw);
          y = this.drawNotaCreditoFooter(doc, data, y, pw);
        } else if (data.codDoc === '05') {
          // Nota de Débito body
          y = this.drawNotaDebitoBuyerInfo(doc, data, y, pw);
          y = this.drawNotaDebitoMotivosTable(doc, data, y, pw);
          y = this.drawNotaDebitoFooter(doc, data, y, pw);
        } else if (data.codDoc === '06') {
          // Guía de Remisión body
          y = this.drawGuiaRemisionTransportInfo(doc, data, y, pw);
          y = this.drawGuiaRemisionDestinatarios(doc, data, y, pw);
          y = this.drawGuiaRemisionFooter(doc, data, y, pw);
        } else {
          // Factura body (default)
          y = this.drawBuyerInfo(doc, data, y, pw);
          y = this.drawDetailTable(doc, data, y, pw);
          y = this.drawFooter(doc, data, y, pw);
        }

        this.drawBrandFooter(doc, data);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  HEADER — Matches SRI RIDE standard exactly
  //  Left: Logo box (top) + Company info box (bottom)
  //  Right: Single box with RUC, doc type, auth, barcode
  // ══════════════════════════════════════════════════════════════════
  private drawHeader(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number, barcodeBuffer?: Buffer): number {
    const x = PAGE_ML;
    const leftW = Math.round(pw * 0.42);
    const gap = 10;
    const rightW = pw - leftW - gap;
    const rightX = x + leftW + gap;
    const rPad = 8;
    const rInner = rightW - rPad * 2;
    const rLabelW = 130; // wide label column for right box
    const lPad = 8;
    const lInner = leftW - lPad * 2;
    const lLabelW = 78; // label column for left company info

    // ── Calculate right box height ──
    let rh = 10; // top padding
    // R.U.C. line (label small, number large)
    rh += 20;
    // Doc type (FACTURA) centered
    rh += 20;
    // No. line
    rh += 16;
    // "NUMERO DE AUTORIZACION" label
    rh += 14;
    // Auth number value
    const authNumH = doc.font(FONT_NORMAL).fontSize(7.5).heightOfString(data.numeroAutorizacion || ' ', { width: rInner });
    rh += authNumH + 6;
    // "FECHA Y HORA DE AUTORIZACION:" label + value (two-column row, label may wrap)
    const fechaLabelH = doc.font(FONT_BOLD).fontSize(8.5).heightOfString('FECHA Y HORA DE\nAUTORIZACION:', { width: rLabelW });
    rh += Math.max(fechaLabelH, 12) + 6;
    // AMBIENTE row
    rh += 16;
    // EMISION row
    rh += 16;
    // "CLAVE DE ACCESO" label
    rh += 16;
    // Barcode
    const barcodeH = barcodeBuffer ? 44 : 0;
    rh += barcodeH + 4;
    // Clave de acceso text
    rh += 12;
    rh += 8; // bottom padding
    const rightBoxH = rh;

    // ── Calculate left content height (logo + company info) ──
    const logoH = data.logoBuffer ? 110 : 0;
    const logoGap = data.logoBuffer ? 4 : 0;

    // Only show "Direccion Sucursal" when it differs from "Direccion Matriz"
    // (avoid printing the same address twice).
    const normAddr = (s?: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const showSucursal =
      !!data.dirEstablecimiento && normAddr(data.dirEstablecimiento) !== normAddr(data.dirMatriz);

    let compInfoH = 10; // top padding
    const rsH = doc.font(FONT_BOLD).fontSize(9).heightOfString(data.razonSocial, { width: lInner });
    compInfoH += rsH + 6;
    if (data.nombreComercial) {
      const ncH = doc.font(FONT_NORMAL).fontSize(8).heightOfString(data.nombreComercial, { width: lInner });
      compInfoH += ncH + 8;
    }
    if (data.dirMatriz) {
      const dmH = doc.font(FONT_NORMAL).fontSize(8).heightOfString(data.dirMatriz, { width: lInner - lLabelW });
      compInfoH += Math.max(12, dmH) + 6;
    }
    if (showSucursal) {
      const deH = doc.font(FONT_NORMAL).fontSize(8).heightOfString(data.dirEstablecimiento!, { width: lInner - lLabelW });
      compInfoH += Math.max(12, deH) + 6;
    }
    // Contactos del emisor: misma fila "Etiqueta: valor" que las direcciones. El alto de
    // cada fila es el mayor entre etiqueta y valor, para que nada se corte ni se monte.
    const contactos = (data.contactosEmisor || []).filter((c) => c && c.nombre && c.valor);
    const contactoRowH = (c: { nombre: string; valor: string }) => {
      const labelH = doc.font(FONT_BOLD).fontSize(8).heightOfString(`${c.nombre}:`, { width: lLabelW - 4 });
      const valueH = doc.font(FONT_NORMAL).fontSize(8).heightOfString(c.valor, { width: lInner - lLabelW });
      return Math.max(12, labelH, valueH) + 4;
    };
    for (const c of contactos) compInfoH += contactoRowH(c);
    if (data.contribuyenteEspecial) compInfoH += 16;
    compInfoH += 16; // obligado contab
    if (data.agenteRetencion) compInfoH += 16;
    if (data.contribuyenteRimpe) {
      const crH = doc.font(FONT_BOLD).fontSize(8).heightOfString(data.contribuyenteRimpe, { width: lInner });
      compInfoH += crH + 4;
    }
    compInfoH += 8; // bottom padding

    const leftTotalH = logoH + logoGap + compInfoH;
    const totalH = Math.max(leftTotalH, rightBoxH);

    // ══════════════════════════════════════════════
    //  DRAW RIGHT BOX
    // ══════════════════════════════════════════════
    this.box(doc, rightX, startY, rightW, totalH);

    let ry = startY + 10;

    // R.U.C.: (small label) + number (large bold)
    doc.font(FONT_NORMAL).fontSize(9);
    doc.text('R.U.C.:', rightX + rPad, ry + 3);
    doc.font(FONT_BOLD).fontSize(14);
    doc.text(data.ruc, rightX + rPad + 50, ry, { width: rInner - 50 });
    ry += 20;

    // Document type (centered, bold, large)
    const docLabel = DOC_TYPE_LABELS[data.codDoc] || 'DOCUMENTO';
    doc.font(FONT_BOLD).fontSize(12);
    doc.text(docLabel, rightX + rPad, ry, { width: rInner, align: 'center' });
    ry += 20;

    // No. (label:value layout)
    doc.font(FONT_NORMAL).fontSize(9);
    doc.text('No.', rightX + rPad, ry);
    const nro = `${data.establecimiento}-${data.puntoEmision}-${data.secuencial}`;
    doc.text(nro, rightX + rPad + 50, ry, { width: rInner - 50 });
    ry += 16;

    // NUMERO DE AUTORIZACION
    doc.font(FONT_BOLD).fontSize(9);
    doc.text('NUMERO DE AUTORIZACION', rightX + rPad, ry, { width: rInner });
    ry += 14;
    doc.font(FONT_NORMAL).fontSize(7.5);
    doc.text(data.numeroAutorizacion, rightX + rPad, ry, { width: rInner });
    ry += authNumH + 6;

    // FECHA Y HORA DE AUTORIZACION: value (two-column)
    doc.font(FONT_BOLD).fontSize(8.5);
    doc.text('FECHA Y HORA DE\nAUTORIZACION:', rightX + rPad, ry, { width: rLabelW });
    doc.font(FONT_NORMAL).fontSize(9);
    doc.text(data.fechaAutorizacion, rightX + rPad + rLabelW, ry, { width: rInner - rLabelW });
    ry += Math.max(fechaLabelH, 12) + 6;

    // AMBIENTE:
    doc.font(FONT_BOLD).fontSize(9);
    doc.text('AMBIENTE:', rightX + rPad, ry, { width: rLabelW });
    const ambienteLabel = data.ambiente === '2' ? 'PRODUCCION' : 'PRUEBAS';
    doc.font(FONT_NORMAL).fontSize(9);
    doc.text(ambienteLabel, rightX + rPad + rLabelW, ry, { width: rInner - rLabelW });
    ry += 16;

    // EMISION:
    doc.font(FONT_BOLD).fontSize(9);
    doc.text('EMISION:', rightX + rPad, ry, { width: rLabelW });
    doc.font(FONT_NORMAL).fontSize(9);
    doc.text('NORMAL', rightX + rPad + rLabelW, ry, { width: rInner - rLabelW });
    ry += 16;

    // CLAVE DE ACCESO
    doc.font(FONT_BOLD).fontSize(9);
    doc.text('CLAVE DE ACCESO', rightX + rPad, ry, { width: rInner });
    ry += 16;

    // Barcode (Code 128)
    if (barcodeBuffer) {
      try {
        const barcodeW = rInner - 10;
        const barcodeX = rightX + rPad + 5;
        doc.image(barcodeBuffer, barcodeX, ry, {
          width: barcodeW,
          height: barcodeH,
        });
      } catch (err: any) {
        this.logger.warn(`Could not render barcode in RIDE: ${err.message}`);
      }
      ry += barcodeH + 4;
    }

    // Clave de acceso text below barcode
    doc.font(FONT_NORMAL).fontSize(6.5);
    doc.text(data.claveAcceso, rightX + rPad, ry, { width: rInner, align: 'center' });

    // ══════════════════════════════════════════════
    //  DRAW LEFT COLUMN: Logo (top) + Company info (bottom)
    // ══════════════════════════════════════════════

    // Logo (no border). Confined to its slot with `fit` (keeps aspect ratio,
    // never exceeds the box) AND a hard clip region as a safety net so a logo
    // can never spill outside its area regardless of its dimensions/metadata.
    if (data.logoBuffer) {
      const padX = 10;
      const padY = 8;
      const logoMaxW = leftW - padX * 2;
      const logoMaxH = logoH - padY * 2;
      try {
        doc.save();
        doc.rect(x + padX, startY + padY, logoMaxW, logoMaxH).clip();
        doc.image(data.logoBuffer, x + padX, startY + padY, {
          fit: [logoMaxW, logoMaxH],
          align: 'center',
          valign: 'center',
        });
        doc.restore();
      } catch (err: any) {
        doc.restore();
        this.logger.warn(`Could not render logo in RIDE: ${err.message}`);
      }
    }

    // Company info box
    const compInfoY = startY + logoH + logoGap;
    const compBoxH = totalH - logoH - logoGap;
    this.box(doc, x, compInfoY, leftW, compBoxH);

    // When there is no logo, the box is much taller than the info, leaving a big
    // empty space. Anchor the company info to the bottom edge of the box instead.
    const bottomSlack = !data.logoBuffer ? Math.max(0, compBoxH - compInfoH) : 0;
    let ly = compInfoY + 10 + bottomSlack;

    // Razon social (left-aligned, bold)
    doc.font(FONT_BOLD).fontSize(9);
    doc.text(data.razonSocial, x + lPad, ly, { width: lInner });
    ly += rsH + 6;

    // Nombre comercial
    if (data.nombreComercial) {
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(data.nombreComercial, x + lPad, ly, { width: lInner });
      const ncH2 = doc.heightOfString(data.nombreComercial, { width: lInner });
      ly += ncH2 + 8;
    }

    // Direccion Matriz
    if (data.dirMatriz) {
      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Direccion\nMatriz:', x + lPad, ly, { width: lLabelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(data.dirMatriz, x + lPad + lLabelW, ly, { width: lInner - lLabelW });
      const dmH2 = doc.heightOfString(data.dirMatriz, { width: lInner - lLabelW });
      ly += Math.max(12, dmH2) + 6;
    }

    // Direccion Sucursal (solo si difiere de la matriz)
    if (showSucursal) {
      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Direccion\nSucursal:', x + lPad, ly, { width: lLabelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(data.dirEstablecimiento!, x + lPad + lLabelW, ly, { width: lInner - lLabelW });
      const deH2 = doc.heightOfString(data.dirEstablecimiento!, { width: lInner - lLabelW });
      ly += Math.max(12, deH2) + 6;
    }

    // Contactos del emisor
    for (const c of contactos) {
      const rowH = contactoRowH(c);
      doc.font(FONT_BOLD).fontSize(8);
      doc.text(`${c.nombre}:`, x + lPad, ly, { width: lLabelW - 4 });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(c.valor, x + lPad + lLabelW, ly, { width: lInner - lLabelW });
      ly += rowH;
    }

    // Contribuyente Especial
    if (data.contribuyenteEspecial) {
      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Contribuyente Especial Nro  ', x + lPad, ly, { width: lInner * 0.75, continued: false });
      doc.font(FONT_NORMAL).text(data.contribuyenteEspecial, x + lPad + lInner * 0.75, ly, { width: lInner * 0.25 });
      ly += 16;
    }

    // OBLIGADO A LLEVAR CONTABILIDAD
    doc.font(FONT_BOLD).fontSize(8);
    const oblLabelW = lInner * 0.78;
    doc.text('OBLIGADO A LLEVAR CONTABILIDAD', x + lPad, ly, { width: oblLabelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.obligadoContabilidad, x + lPad + oblLabelW, ly, { width: lInner - oblLabelW });
    ly += 16;

    // Agente de Retencion
    if (data.agenteRetencion) {
      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Agente de Retencion Resolucion No.', x + lPad, ly, { width: oblLabelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(data.agenteRetencion, x + lPad + oblLabelW, ly, { width: lInner - oblLabelW });
      ly += 16;
    }

    // RIMPE
    if (data.contribuyenteRimpe) {
      doc.font(FONT_BOLD).fontSize(8);
      doc.text(data.contribuyenteRimpe, x + lPad, ly, { width: lInner });
    }

    return startY + totalH + 8;
  }

  // ══════════════════════════════════════════════════════════════════
  //  BUYER INFO — Full-width box
  // ══════════════════════════════════════════════════════════════════
  private drawBuyerInfo(doc: PDFKit.PDFDocument, data: RideData, y: number, pw: number): number {
    const x = PAGE_ML;
    const pad = 10;
    const labelW = 195;
    const valX = x + pad + labelW;
    const valW = pw - pad * 2 - labelW;
    const boxH = 56;

    this.box(doc, x, y, pw, boxH);

    let by = y + 10;
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Razon Social/Nombres y Apellidos:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.razonSocialComprador, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Identificacion:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.identificacionComprador, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmision, valX, by, { width: valW });

    return y + boxH + 6;
  }

  // ══════════════════════════════════════════════════════════════════
  //  DETAIL TABLE — Items with header row
  // ══════════════════════════════════════════════════════════════════
  private drawDetailTable(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const x = PAGE_ML;
    let y = startY;

    // Column definitions
    const cols = [
      { label: 'Cod.', width: 68, align: 'center' as const },
      { label: 'Cant.', width: 34, align: 'center' as const },
      { label: 'Descripcion', width: pw - 68 - 34 - 40 - 34 - 56 - 48 - 70, align: 'left' as const },
      { label: 'IVA', width: 40, align: 'center' as const },
      { label: 'UNI', width: 34, align: 'center' as const },
      { label: 'Precio', width: 56, align: 'right' as const },
      { label: 'Dsct.', width: 48, align: 'center' as const },
      { label: 'Precio Total', width: 70, align: 'right' as const },
    ];

    const headerH = 18;

    // ── Header row ──
    this.box(doc, x, y, pw, headerH);
    doc.font(FONT_BOLD).fontSize(7.5);
    let cx = x;
    for (const col of cols) {
      doc.text(col.label, cx + 3, y + 5, { width: col.width - 6, align: 'center' });
      // Vertical separator
      if (cx > x) {
        doc.moveTo(cx, y).lineTo(cx, y + headerH).stroke();
      }
      cx += col.width;
    }
    y += headerH;

    // ── Data rows ──
    doc.font(FONT_NORMAL).fontSize(7);
    for (const det of data.detalles) {
      const ivaLabel = det.impuestos[0]
        ? (IVA_RATE_LABELS[det.impuestos[0].codigoPorcentaje] || `${det.impuestos[0].tarifa}%`)
        : '0%';
      const descPct = det.precioUnitario > 0
        ? ((det.descuento / (det.precioUnitario * det.cantidad)) * 100).toFixed(2) + '%'
        : '0,00%';

      // Calculate row height from the tallest cell content
      const codColWidth = cols[0].width - 6;
      const descColWidth = cols[2].width - 6;
      const codHeight = doc.heightOfString(det.codigoPrincipal, { width: codColWidth });
      const descHeight = doc.heightOfString(det.descripcion, { width: descColWidth });
      const rowH = Math.max(16, codHeight + 6, descHeight + 6);

      // Check for page break
      if (y + rowH > doc.page.height - 80) {
        doc.addPage();
        y = PAGE_MT;
      }

      // Row border
      this.box(doc, x, y, pw, rowH);

      // Vertical separators + cell content
      cx = x;
      const cellData = [
        det.codigoPrincipal,
        String(det.cantidad),
        det.descripcion,
        ivaLabel,
        'UNI',
        det.precioUnitario.toFixed(2),
        descPct,
        det.precioTotalSinImpuesto.toFixed(2),
      ];

      for (let i = 0; i < cols.length; i++) {
        if (i > 0) {
          doc.moveTo(cx, y).lineTo(cx, y + rowH).stroke();
        }
        const align = cols[i].align;
        const cellW = cols[i].width - 6;
        const cellH = doc.heightOfString(cellData[i], { width: cellW });
        const cellY = y + Math.max(4, (rowH - cellH) / 2);
        doc.text(cellData[i], cx + 3, cellY, { width: cellW, align });
        cx += cols[i].width;
      }

      y += rowH;
    }

    return y + 4;
  }

  // ══════════════════════════════════════════════════════════════════
  //  FOOTER — Info Adicional (left) + Totals (right) + Payments
  // ══════════════════════════════════════════════════════════════════
  /** Configurable branding footer (per account), drawn at the bottom of the last page. */
  private drawBrandFooter(doc: PDFKit.PDFDocument, data: RideData): void {
    const text = (data.brandFooter || '').trim();
    if (!text) return;
    const pw = doc.page.width - PAGE_ML - PAGE_MR;
    // Writing inside the bottom margin makes PDFKit auto-add a blank page.
    // Temporarily drop the bottom margin so the footer stays on the current page.
    const prevBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
      doc.font(FONT_NORMAL).fontSize(7).fillColor('#888888');
      doc.text(text, PAGE_ML, doc.page.height - 20, { width: pw, align: 'center', lineBreak: false });
      doc.fillColor('#000000');
    } finally {
      doc.page.margins.bottom = prevBottom;
    }
  }

  private drawFooter(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const x = PAGE_ML;
    let y = startY;
    const halfW = Math.round(pw / 2);
    const gap = 6;
    const leftW = halfW - gap / 2;
    const rightW = pw - leftW - gap;
    const rightX = x + leftW + gap;

    // ── Build totals array first to know height ──
    const totals = this.buildTotalsArray(data);
    const totalsRowH = 14;
    const totalsH = totals.length * totalsRowH + 12;

    // ── Info Adicional (left) ──
    const hasInfo = data.infoAdicional && data.infoAdicional.length > 0;
    const infoRows = hasInfo ? this.infoAdicionalRowHeights(doc, data.infoAdicional!, leftW) : [];
    const infoH = hasInfo ? Math.max(totalsH, this.sum(infoRows) + 24) : totalsH;

    if (hasInfo) {
      this.box(doc, x, y, leftW, infoH);
      this.drawInfoAdicional(doc, data.infoAdicional!, infoRows, x, y, leftW);
    }

    // ── Totals box (right) ──
    this.box(doc, rightX, y, rightW, totalsH);

    const labelW = rightW * 0.62;
    const valW = rightW * 0.38 - 12;

    let ty = y + 6;
    doc.fontSize(7.5);
    for (const row of totals) {
      doc.font(row.bold ? FONT_BOLD : FONT_NORMAL);
      doc.text(row.label, rightX + 6, ty, { width: labelW });
      doc.text(row.value, rightX + labelW + 6, ty, { width: valW, align: 'right' });
      ty += totalsRowH;
    }

    y += Math.max(infoH, totalsH) + 8;

    // ── Check page break for payments ──
    if (y + 40 > doc.page.height - 30) {
      doc.addPage();
      y = PAGE_MT;
    }

    // ── Payment table ──
    const payTableW = pw * 0.72;
    const payCols = [
      { label: 'Forma de Pago', width: payTableW * 0.50 },
      { label: 'Valor', width: payTableW * 0.20 },
      { label: 'Plazo', width: payTableW * 0.15 },
      { label: 'Tiempo', width: payTableW * 0.15 },
    ];

    // Header
    const payHeaderH = 16;
    this.box(doc, x, y, payTableW, payHeaderH);
    doc.font(FONT_BOLD).fontSize(7);
    let px = x;
    for (let i = 0; i < payCols.length; i++) {
      doc.text(payCols[i].label, px + 3, y + 4, { width: payCols[i].width - 6, align: 'center' });
      if (i > 0) doc.moveTo(px, y).lineTo(px, y + payHeaderH).stroke();
      px += payCols[i].width;
    }
    y += payHeaderH;

    // Payment rows
    doc.font(FONT_NORMAL).fontSize(7);
    for (const pago of data.pagos) {
      const payRowH = 14;
      this.box(doc, x, y, payTableW, payRowH);
      px = x;

      const payLabel = SRI_PAYMENT_METHODS[pago.formaPago] || pago.formaPago;
      doc.text(`${pago.formaPago}  ${payLabel}`, px + 3, y + 3, { width: payCols[0].width - 6 });
      px += payCols[0].width;
      doc.moveTo(px, y).lineTo(px, y + payRowH).stroke();
      doc.text(pago.total.toFixed(2), px + 3, y + 3, { width: payCols[1].width - 6, align: 'right' });
      px += payCols[1].width;
      doc.moveTo(px, y).lineTo(px, y + payRowH).stroke();
      doc.text(String(pago.plazo ?? ''), px + 3, y + 3, { width: payCols[2].width - 6, align: 'center' });
      px += payCols[2].width;
      doc.moveTo(px, y).lineTo(px, y + payRowH).stroke();
      doc.text(pago.unidadTiempo?.toUpperCase() ?? 'DIAS', px + 3, y + 3, { width: payCols[3].width - 6, align: 'center' });

      y += payRowH;
    }

    return y;
  }

  // ── Totals array builder ──
  private buildTotalsArray(data: RideData): { label: string; value: string; bold?: boolean }[] {
    const rows: { label: string; value: string; bold?: boolean }[] = [];

    let subtotal15 = 0, subtotal0 = 0, subtotalNoObj = 0, subtotalExento = 0;
    let iva15 = 0, ice = 0;

    for (const imp of data.totalConImpuestos) {
      if (imp.codigo === '2') { // IVA
        switch (imp.codigoPorcentaje) {
          case '4': case '3': case '2':
            subtotal15 += imp.baseImponible;
            iva15 += imp.valor;
            break;
          case '0':
            subtotal0 += imp.baseImponible;
            break;
          case '6':
            subtotalNoObj += imp.baseImponible;
            break;
          case '7':
            subtotalExento += imp.baseImponible;
            break;
        }
      } else if (imp.codigo === '3') { // ICE
        ice += imp.valor;
      }
    }

    const ivaRate = data.totalConImpuestos.find(i => i.codigo === '2' && ['2', '3', '4'].includes(i.codigoPorcentaje));
    const ivaLabel = ivaRate
      ? `IVA ${IVA_RATE_LABELS[ivaRate.codigoPorcentaje] || ''}:`
      : 'IVA 15%:';

    rows.push({ label: `Subtotal ${IVA_RATE_LABELS[ivaRate?.codigoPorcentaje ?? '4'] || '15%'}:`, value: subtotal15.toFixed(2) });
    rows.push({ label: 'Subtotal 0%:', value: subtotal0.toFixed(2) });
    rows.push({ label: 'Subtotal No obj. de:', value: subtotalNoObj.toFixed(2) });
    rows.push({ label: 'Subtotal Excento de:', value: subtotalExento.toFixed(2) });
    rows.push({ label: 'Subtotal Sin:', value: data.totalSinImpuestos.toFixed(2) });
    rows.push({ label: 'Total Descuento:', value: data.totalDescuento.toFixed(2) });
    rows.push({ label: 'ICE:', value: ice.toFixed(2) });
    rows.push({ label: ivaLabel, value: iva15.toFixed(2) });
    rows.push({ label: 'VALOR TOTAL:', value: data.importeTotal.toFixed(2), bold: true });

    return rows;
  }

  // ══════════════════════════════════════════════════════════════════
  //  RETENCIÓN — Buyer Info
  // ══════════════════════════════════════════════════════════════════
  private drawRetencionBuyerInfo(doc: PDFKit.PDFDocument, data: RideData, y: number, pw: number): number {
    const x = PAGE_ML;
    const pad = 10;
    const labelW = 220;
    const valX = x + pad + labelW;
    const valW = pw - pad * 2 - labelW;
    const boxH = 56;

    this.box(doc, x, y, pw, boxH);

    let by = y + 10;
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Razon Social / Nombres y Apellidos:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.razonSocialComprador, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Identificacion:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.identificacionComprador, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmision, valX, by, { width: valW });

    return y + boxH + 6;
  }

  // ══════════════════════════════════════════════════════════════════
  //  RETENCIÓN — Detail Table
  // ══════════════════════════════════════════════════════════════════
  private drawRetencionTable(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const x = PAGE_ML;
    let y = startY;

    const cols = [
      { label: 'Comprobante', width: Math.round(pw * 0.12), align: 'center' as const },
      { label: 'Numero', width: Math.round(pw * 0.17), align: 'center' as const },
      { label: 'Fecha Emision', width: Math.round(pw * 0.11), align: 'center' as const },
      { label: 'Ejercicio Fiscal', width: Math.round(pw * 0.10), align: 'center' as const },
      { label: 'Base Imponible', width: Math.round(pw * 0.12), align: 'right' as const },
      { label: 'IMPUESTO', width: Math.round(pw * 0.10), align: 'center' as const },
      { label: '% Retencion', width: Math.round(pw * 0.10), align: 'center' as const },
      { label: 'Valor Retenido', width: 0, align: 'right' as const },
    ];
    // Last column gets remaining width
    cols[cols.length - 1].width = pw - cols.slice(0, -1).reduce((s, c) => s + c.width, 0);

    const headerH = 18;
    this.box(doc, x, y, pw, headerH);
    doc.font(FONT_BOLD).fontSize(6.5);
    let cx = x;
    for (const col of cols) {
      doc.text(col.label, cx + 2, y + 4, { width: col.width - 4, align: 'center' });
      if (cx > x) {
        doc.moveTo(cx, y).lineTo(cx, y + headerH).stroke();
      }
      cx += col.width;
    }
    y += headerH;

    // Data rows
    doc.font(FONT_NORMAL).fontSize(6.5);
    const impuestos = data.impuestosRetencion || [];
    for (const imp of impuestos) {
      const rowH = 16;

      if (y + rowH > doc.page.height - 80) {
        doc.addPage();
        y = PAGE_MT;
      }

      this.box(doc, x, y, pw, rowH);

      cx = x;
      const docSustentoLabel = DOC_SUSTENTO_LABELS[imp.codDocSustento] || imp.codDocSustento;
      const impLabel = RETENTION_TAX_LABELS[imp.codigo] || imp.codigo;

      const cellData = [
        docSustentoLabel,
        imp.numDocSustento,
        imp.fechaEmisionDocSustento,
        data.periodoFiscal || '',
        imp.baseImponible.toFixed(2),
        impLabel,
        `${imp.porcentajeRetener.toFixed(2)}%`,
        imp.valorRetenido.toFixed(2),
      ];

      for (let i = 0; i < cols.length; i++) {
        if (i > 0) {
          doc.moveTo(cx, y).lineTo(cx, y + rowH).stroke();
        }
        const cellW = cols[i].width - 4;
        doc.text(cellData[i], cx + 2, y + 4, { width: cellW, align: cols[i].align });
        cx += cols[i].width;
      }

      y += rowH;
    }

    return y + 4;
  }

  // ══════════════════════════════════════════════════════════════════
  //  RETENCIÓN — Footer (Info Adicional + Total Retenido)
  // ══════════════════════════════════════════════════════════════════
  private drawRetencionFooter(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const x = PAGE_ML;
    let y = startY;
    const halfW = Math.round(pw / 2);
    const gap = 6;
    const leftW = halfW - gap / 2;
    const rightW = pw - leftW - gap;
    const rightX = x + leftW + gap;

    // Calculate total retenido
    const totalRetenido = (data.impuestosRetencion || []).reduce((s, i) => s + i.valorRetenido, 0);

    // Right: Total box
    const totalsH = 32;
    this.box(doc, rightX, y, rightW, totalsH);
    const labelW = rightW * 0.62;
    const valW = rightW * 0.38 - 12;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('TOTAL RETENIDO:', rightX + 6, y + 10, { width: labelW });
    doc.text(totalRetenido.toFixed(2), rightX + labelW + 6, y + 10, { width: valW, align: 'right' });

    // Left: Info Adicional
    const hasInfo = data.infoAdicional && data.infoAdicional.length > 0;
    const infoRows = hasInfo ? this.infoAdicionalRowHeights(doc, data.infoAdicional!, leftW) : [];
    const infoH = hasInfo ? Math.max(totalsH, this.sum(infoRows) + 24) : totalsH;

    if (hasInfo) {
      this.box(doc, x, y, leftW, infoH);
      this.drawInfoAdicional(doc, data.infoAdicional!, infoRows, x, y, leftW);
    }

    return y + Math.max(infoH, totalsH) + 8;
  }

  // ══════════════════════════════════════════════════════════════════
  //  NOTA DE CRÉDITO — Buyer Info + Doc Modificado
  // ══════════════════════════════════════════════════════════════════
  private drawNotaCreditoBuyerInfo(doc: PDFKit.PDFDocument, data: RideData, y: number, pw: number): number {
    const x = PAGE_ML;
    const pad = 10;
    const labelW = 260;
    const valX = x + pad + labelW;
    const valW = pw - pad * 2 - labelW;

    // Calculate box height: 6 rows × 16 + padding
    const boxH = 6 * 16 + 16;

    this.box(doc, x, y, pw, boxH);

    let by = y + 8;

    // Razón Social
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Razon Social / Nombres y Apellidos:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.razonSocialComprador, valX, by, { width: valW });
    by += 16;

    // Identificación
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Identificacion:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.identificacionComprador, valX, by, { width: valW });
    by += 16;

    // Fecha Emisión
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmision, valX, by, { width: valW });
    by += 16;

    // Comprobante que se modifica
    const docModLabel = DOC_TYPE_LABELS[data.codDocModificado || '01'] || 'DOCUMENTO';
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Comprobante que se modifica:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(`${docModLabel}   ${data.numDocModificado || ''}`, valX, by, { width: valW });
    by += 16;

    // Fecha Emisión (Comprobante a modificar)
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision (Comprobante a modificar):', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmisionDocSustento || '', valX, by, { width: valW });
    by += 16;

    // Razón de Modificación
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Razon de Modificacion:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.motivo || '', valX, by, { width: valW });

    return y + boxH + 6;
  }

  // ══════════════════════════════════════════════════════════════════
  //  NOTA DE CRÉDITO — Footer (Info Adicional + Totals + Payments)
  // ══════════════════════════════════════════════════════════════════
  private drawNotaCreditoFooter(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    // NC footer is same as factura footer — reuse it
    return this.drawFooter(doc, data, startY, pw);
  }

  // ══════════════════════════════════════════════════════════════════
  //  NOTA DE DÉBITO — Buyer Info + Doc Modificado
  // ══════════════════════════════════════════════════════════════════
  private drawNotaDebitoBuyerInfo(doc: PDFKit.PDFDocument, data: RideData, y: number, pw: number): number {
    // Same layout as NC buyer info — 6 rows with doc modification info
    const x = PAGE_ML;
    const pad = 10;
    const labelW = 260;
    const valX = x + pad + labelW;
    const valW = pw - pad * 2 - labelW;

    const boxH = 6 * 16 + 16;
    this.box(doc, x, y, pw, boxH);

    let by = y + 8;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Razon Social / Nombres y Apellidos:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.razonSocialComprador, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Identificacion:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.identificacionComprador, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmision, valX, by, { width: valW });
    by += 16;

    const docModLabel = DOC_TYPE_LABELS[data.codDocModificado || '01'] || 'DOCUMENTO';
    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Comprobante que se modifica:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(`${docModLabel}   ${data.numDocModificado || ''}`, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision (Comprobante a modificar):', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmisionDocSustento || '', valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Valor Total:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text((data.valorModificacion ?? 0).toFixed(2), valX, by, { width: valW });

    return y + boxH + 6;
  }

  // ══════════════════════════════════════════════════════════════════
  //  NOTA DE DÉBITO — Motivos Table
  // ══════════════════════════════════════════════════════════════════
  private drawNotaDebitoMotivosTable(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const x = PAGE_ML;
    let y = startY;

    const cols = [
      { label: 'Razon', width: pw - 100, align: 'left' as const },
      { label: 'Valor', width: 100, align: 'right' as const },
    ];

    const headerH = 18;
    this.box(doc, x, y, pw, headerH);
    doc.font(FONT_BOLD).fontSize(7.5);
    let cx = x;
    for (const col of cols) {
      doc.text(col.label, cx + 3, y + 5, { width: col.width - 6, align: 'center' });
      if (cx > x) {
        doc.moveTo(cx, y).lineTo(cx, y + headerH).stroke();
      }
      cx += col.width;
    }
    y += headerH;

    doc.font(FONT_NORMAL).fontSize(7);
    const motivos = data.motivosND || [];
    for (const m of motivos) {
      const descColWidth = cols[0].width - 6;
      const descHeight = doc.heightOfString(m.razon, { width: descColWidth });
      const rowH = Math.max(16, descHeight + 6);

      if (y + rowH > doc.page.height - 80) {
        doc.addPage();
        y = PAGE_MT;
      }

      this.box(doc, x, y, pw, rowH);

      cx = x;
      // Razon
      const cellH = doc.heightOfString(m.razon, { width: descColWidth });
      const cellY = y + Math.max(4, (rowH - cellH) / 2);
      doc.text(m.razon, cx + 3, cellY, { width: descColWidth, align: 'left' });
      cx += cols[0].width;

      // Valor
      doc.moveTo(cx, y).lineTo(cx, y + rowH).stroke();
      const valW = cols[1].width - 6;
      doc.text(m.valor.toFixed(2), cx + 3, y + 4, { width: valW, align: 'right' });

      y += rowH;
    }

    return y + 4;
  }

  // ══════════════════════════════════════════════════════════════════
  //  NOTA DE DÉBITO — Footer (Info Adicional + Totals + Payments)
  // ══════════════════════════════════════════════════════════════════
  private drawNotaDebitoFooter(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    return this.drawFooter(doc, data, startY, pw);
  }

  // ══════════════════════════════════════════════════════════════════
  //  GUÍA DE REMISIÓN — Transport + Sender Info
  // ══════════════════════════════════════════════════════════════════
  private drawGuiaRemisionTransportInfo(doc: PDFKit.PDFDocument, data: RideData, y: number, pw: number): number {
    const gr = data.guiaRemisionData;
    if (!gr) return y;

    const x = PAGE_ML;
    const pad = 10;
    const labelW = 260;
    const valX = x + pad + labelW;
    const valW = pw - pad * 2 - labelW;

    const boxH = 8 * 16 + 16;
    this.box(doc, x, y, pw, boxH);

    let by = y + 8;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Direccion Partida:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.dirPartida, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Razon Social / Nombres Transportista:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.razonSocialTransportista, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('RUC / CI Transportista:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.rucTransportista, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Placa:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.placa, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Inicio Transporte:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.fechaIniTransporte, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Fin Transporte:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.fechaFinTransporte, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Fecha Emision:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(data.fechaEmision, valX, by, { width: valW });
    by += 16;

    doc.font(FONT_BOLD).fontSize(8);
    doc.text('Punto de Partida:', x + pad, by, { width: labelW });
    doc.font(FONT_NORMAL).fontSize(8);
    doc.text(gr.dirPartida, valX, by, { width: valW });

    return y + boxH + 6;
  }

  // ══════════════════════════════════════════════════════════════════
  //  GUÍA DE REMISIÓN — Destinatarios + Items
  // ══════════════════════════════════════════════════════════════════
  private drawGuiaRemisionDestinatarios(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const gr = data.guiaRemisionData;
    if (!gr) return startY;

    const x = PAGE_ML;
    let y = startY;

    for (const dest of gr.destinatarios) {
      // Destinatario header box
      const pad = 10;
      const labelW = 260;
      const valX = x + pad + labelW;
      const valW = pw - pad * 2 - labelW;

      let rowCount = 4; // base rows: identificacion, razonSocial, dirDestinatario, motivoTraslado
      if (dest.codDocSustento) rowCount++;
      if (dest.numDocSustento) rowCount++;
      if (dest.ruta) rowCount++;
      const destBoxH = rowCount * 16 + 16;

      if (y + destBoxH > doc.page.height - 80) {
        doc.addPage();
        y = PAGE_MT;
      }

      this.box(doc, x, y, pw, destBoxH);

      let by = y + 8;

      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Identificacion Destinatario:', x + pad, by, { width: labelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(dest.identificacionDestinatario, valX, by, { width: valW });
      by += 16;

      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Razon Social Destinatario:', x + pad, by, { width: labelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(dest.razonSocialDestinatario, valX, by, { width: valW });
      by += 16;

      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Direccion Destinatario:', x + pad, by, { width: labelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(dest.dirDestinatario, valX, by, { width: valW });
      by += 16;

      doc.font(FONT_BOLD).fontSize(8);
      doc.text('Motivo Traslado:', x + pad, by, { width: labelW });
      doc.font(FONT_NORMAL).fontSize(8);
      doc.text(dest.motivoTraslado, valX, by, { width: valW });
      by += 16;

      if (dest.codDocSustento) {
        const docLabel = DOC_SUSTENTO_LABELS[dest.codDocSustento] || dest.codDocSustento;
        doc.font(FONT_BOLD).fontSize(8);
        doc.text('Documento Sustento:', x + pad, by, { width: labelW });
        doc.font(FONT_NORMAL).fontSize(8);
        doc.text(`${docLabel}   ${dest.numDocSustento || ''}`, valX, by, { width: valW });
        by += 16;
      }

      if (dest.ruta) {
        doc.font(FONT_BOLD).fontSize(8);
        doc.text('Ruta:', x + pad, by, { width: labelW });
        doc.font(FONT_NORMAL).fontSize(8);
        doc.text(dest.ruta, valX, by, { width: valW });
        by += 16;
      }

      y += destBoxH + 4;

      // Items table for this destinatario
      const cols = [
        { label: 'Codigo', width: 100, align: 'center' as const },
        { label: 'Descripcion', width: pw - 100 - 80, align: 'left' as const },
        { label: 'Cantidad', width: 80, align: 'right' as const },
      ];

      const headerH = 18;
      if (y + headerH > doc.page.height - 80) {
        doc.addPage();
        y = PAGE_MT;
      }

      this.box(doc, x, y, pw, headerH);
      doc.font(FONT_BOLD).fontSize(7.5);
      let cx = x;
      for (const col of cols) {
        doc.text(col.label, cx + 3, y + 5, { width: col.width - 6, align: 'center' });
        if (cx > x) {
          doc.moveTo(cx, y).lineTo(cx, y + headerH).stroke();
        }
        cx += col.width;
      }
      y += headerH;

      doc.font(FONT_NORMAL).fontSize(7);
      for (const det of dest.detalles) {
        const descColWidth = cols[1].width - 6;
        const descHeight = doc.heightOfString(det.descripcion, { width: descColWidth });
        const rowH = Math.max(16, descHeight + 6);

        if (y + rowH > doc.page.height - 80) {
          doc.addPage();
          y = PAGE_MT;
        }

        this.box(doc, x, y, pw, rowH);

        cx = x;
        // Codigo
        doc.text(det.codigoInterno || '', cx + 3, y + 4, { width: cols[0].width - 6, align: 'center' });
        cx += cols[0].width;

        // Descripcion
        doc.moveTo(cx, y).lineTo(cx, y + rowH).stroke();
        const cellH = doc.heightOfString(det.descripcion, { width: descColWidth });
        const cellY = y + Math.max(4, (rowH - cellH) / 2);
        doc.text(det.descripcion, cx + 3, cellY, { width: descColWidth, align: 'left' });
        cx += cols[1].width;

        // Cantidad
        doc.moveTo(cx, y).lineTo(cx, y + rowH).stroke();
        doc.text(det.cantidad.toFixed(2), cx + 3, y + 4, { width: cols[2].width - 6, align: 'right' });

        y += rowH;
      }

      y += 6;
    }

    return y + 4;
  }

  // ══════════════════════════════════════════════════════════════════
  //  GUÍA DE REMISIÓN — Footer (Info Adicional only, no totals)
  // ══════════════════════════════════════════════════════════════════
  private drawGuiaRemisionFooter(doc: PDFKit.PDFDocument, data: RideData, startY: number, pw: number): number {
    const x = PAGE_ML;
    let y = startY;

    const hasInfo = data.infoAdicional && data.infoAdicional.length > 0;
    if (!hasInfo) return y;

    const infoRows = this.infoAdicionalRowHeights(doc, data.infoAdicional!, pw);
    const infoH = this.sum(infoRows) + 24;

    if (y + infoH > doc.page.height - 30) {
      doc.addPage();
      y = PAGE_MT;
    }

    this.box(doc, x, y, pw, infoH);
    this.drawInfoAdicional(doc, data.infoAdicional!, infoRows, x, y, pw);

    return y + infoH + 8;
  }

  // ── Información adicional (factura, notas, retención y guía) ──
  private static readonly INFO_LABEL_W = 65;

  /**
   * Alto de cada fila de "Informacion Adicional". Una fila de una línea mide 13, como
   * siempre; si la etiqueta o el valor ocupan varias líneas, la fila crece lo necesario
   * para que la siguiente no se dibuje encima.
   */
  private infoAdicionalRowHeights(doc: PDFKit.PDFDocument, campos: { nombre: string; valor: string }[], boxW: number): number[] {
    const labelW = RideService.INFO_LABEL_W;
    const valueW = boxW - 12 - labelW;
    return campos.map((campo) => {
      const labelH = doc.font(FONT_BOLD).fontSize(7).heightOfString(`${campo.nombre}:`, { width: labelW });
      const valueH = doc.font(FONT_NORMAL).fontSize(7).heightOfString(campo.valor ?? '', { width: valueW });
      return Math.max(13, labelH + 4, valueH + 4);
    });
  }

  private drawInfoAdicional(
    doc: PDFKit.PDFDocument, campos: { nombre: string; valor: string }[], rowHeights: number[],
    x: number, y: number, boxW: number,
  ): void {
    doc.font(FONT_BOLD).fontSize(7.5);
    doc.text('Informacion Adicional', x + 6, y + 6, { width: boxW - 12 });

    let iy = y + 20;
    doc.fontSize(7);
    const labelW = RideService.INFO_LABEL_W;
    campos.forEach((campo, i) => {
      doc.font(FONT_BOLD).text(`${campo.nombre}:`, x + 6, iy, { width: labelW });
      doc.font(FONT_NORMAL).text(campo.valor, x + 6 + labelW, iy, { width: boxW - 12 - labelW });
      iy += rowHeights[i];
    });
  }

  private sum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0);
  }

  // ── Barcode generation (Code 128) ──
  private async generateBarcode(claveAcceso: string): Promise<Buffer | undefined> {
    try {
      const png = await bwipjs.toBuffer({
        bcid: 'code128',
        text: claveAcceso,
        scale: 2,
        height: 10,
        includetext: false,
      });
      return png;
    } catch (err: any) {
      this.logger.warn(`Could not generate barcode: ${err.message}`);
      return undefined;
    }
  }

  // ── Utility: draw a stroked rectangle ──
  private box(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number) {
    doc.lineWidth(0.5).rect(x, y, w, h).stroke();
  }
}
