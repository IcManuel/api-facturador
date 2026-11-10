import { create } from 'xmlbuilder2';

/**
 * Generates SRI-compliant XML for Nota de Crédito (tipo 04).
 * Based on: Ficha Técnica del Comprobante Electrónico - Nota de Crédito v1.1.0
 * (Anexo 3: cantidad y precioUnitario con hasta 6 decimales; la 1.0.0 solo admite 2).
 */
export class NotaCreditoGenerator {
  generate(data: NotaCreditoData): string {
    const root = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('notaCredito', {
        id: 'comprobante',
        version: '1.1.0',
      });

    this.buildInfoTributaria(root, data);
    this.buildInfoNotaCredito(root, data);
    this.buildDetalles(root, data);

    if (data.infoAdicional && data.infoAdicional.length > 0) {
      this.buildInfoAdicional(root, data);
    }

    return root.end({ prettyPrint: true });
  }

  private buildInfoTributaria(root: any, data: NotaCreditoData) {
    const info = root.ele('infoTributaria');
    info.ele('ambiente').txt(data.ambiente);
    info.ele('tipoEmision').txt('1');
    info.ele('razonSocial').txt(data.razonSocial);
    if (data.nombreComercial) {
      info.ele('nombreComercial').txt(data.nombreComercial);
    }
    info.ele('ruc').txt(data.ruc);
    info.ele('claveAcceso').txt(data.claveAcceso);
    info.ele('codDoc').txt('04');
    info.ele('estab').txt(data.establecimiento);
    info.ele('ptoEmi').txt(data.puntoEmision);
    info.ele('secuencial').txt(data.secuencial);
    info.ele('dirMatriz').txt(data.dirMatriz);
    if (data.regimenMicroempresas) {
      info.ele('regimenMicroempresas').txt('CONTRIBUYENTE RÉGIMEN MICROEMPRESAS');
    }
    if (data.agenteRetencion) {
      info.ele('agenteRetencion').txt(data.agenteRetencion);
    }
    if (data.contribuyenteRimpe) {
      info.ele('contribuyenteRimpe').txt(data.contribuyenteRimpe);
    }
  }

  private buildInfoNotaCredito(root: any, data: NotaCreditoData) {
    const info = root.ele('infoNotaCredito');
    info.ele('fechaEmision').txt(data.fechaEmision);
    if (data.dirEstablecimiento) {
      info.ele('dirEstablecimiento').txt(data.dirEstablecimiento);
    }
    info.ele('tipoIdentificacionComprador').txt(data.tipoIdentificacionComprador);
    info.ele('razonSocialComprador').txt(data.razonSocialComprador);
    info.ele('identificacionComprador').txt(data.identificacionComprador);
    if (data.contribuyenteEspecial) {
      info.ele('contribuyenteEspecial').txt(data.contribuyenteEspecial);
    }
    info.ele('obligadoContabilidad').txt(data.obligadoContabilidad ?? 'NO');
    if (data.rise) {
      info.ele('rise').txt(data.rise);
    }
    info.ele('codDocModificado').txt(data.codDocModificado);
    info.ele('numDocModificado').txt(data.numDocModificado);
    info.ele('fechaEmisionDocSustento').txt(data.fechaEmisionDocSustento);
    info.ele('totalSinImpuestos').txt(this.decimal(data.totalSinImpuestos));
    info.ele('valorModificacion').txt(this.decimal(data.valorModificacion));
    if (data.moneda) {
      info.ele('moneda').txt(data.moneda);
    }

    // totalConImpuestos
    const totalImpuestos = info.ele('totalConImpuestos');
    for (const imp of data.totalConImpuestos) {
      const ti = totalImpuestos.ele('totalImpuesto');
      ti.ele('codigo').txt(imp.codigo);
      ti.ele('codigoPorcentaje').txt(imp.codigoPorcentaje);
      ti.ele('baseImponible').txt(this.decimal(imp.baseImponible));
      ti.ele('valor').txt(this.decimal(imp.valor));
    }

    info.ele('motivo').txt(data.motivo);
  }

  private buildDetalles(root: any, data: NotaCreditoData) {
    const detalles = root.ele('detalles');
    for (const det of data.detalles) {
      const d = detalles.ele('detalle');
      if (det.codigoInterno) {
        d.ele('codigoInterno').txt(det.codigoInterno);
      }
      if (det.codigoAdicional) {
        d.ele('codigoAdicional').txt(det.codigoAdicional);
      }
      d.ele('descripcion').txt(det.descripcion);
      d.ele('cantidad').txt(this.decimal(det.cantidad, 6));
      d.ele('precioUnitario').txt(this.decimal(det.precioUnitario, 6));
      if (det.descuento != null) {
        d.ele('descuento').txt(this.decimal(det.descuento));
      }
      d.ele('precioTotalSinImpuesto').txt(this.decimal(det.precioTotalSinImpuesto));

      // detallesAdicionales (optional)
      if (det.detallesAdicionales && det.detallesAdicionales.length > 0) {
        const da = d.ele('detallesAdicionales');
        for (const ad of det.detallesAdicionales) {
          da.ele('detAdicional', { nombre: ad.nombre, valor: ad.valor });
        }
      }

      // impuestos del detalle
      const impuestos = d.ele('impuestos');
      for (const imp of det.impuestos) {
        const i = impuestos.ele('impuesto');
        i.ele('codigo').txt(imp.codigo);
        i.ele('codigoPorcentaje').txt(imp.codigoPorcentaje);
        i.ele('tarifa').txt(this.decimal(imp.tarifa));
        i.ele('baseImponible').txt(this.decimal(imp.baseImponible));
        i.ele('valor').txt(this.decimal(imp.valor));
      }
    }
  }

  private buildInfoAdicional(root: any, data: NotaCreditoData) {
    const info = root.ele('infoAdicional');
    for (const campo of data.infoAdicional!) {
      info.ele('campoAdicional', { nombre: campo.nombre }).txt(campo.valor);
    }
  }

  private decimal(value: number, decimals = 2): string {
    return value.toFixed(decimals);
  }
}

// ── Interfaces ──

export interface NotaCreditoData {
  // infoTributaria
  ambiente: string;
  razonSocial: string;
  nombreComercial?: string;
  ruc: string;
  claveAcceso: string;
  establecimiento: string;
  puntoEmision: string;
  secuencial: string;
  dirMatriz: string;
  regimenMicroempresas?: boolean;
  agenteRetencion?: string;
  contribuyenteRimpe?: string;

  // infoNotaCredito
  fechaEmision: string; // DD/MM/AAAA
  dirEstablecimiento?: string;
  tipoIdentificacionComprador: string;
  razonSocialComprador: string;
  identificacionComprador: string;
  contribuyenteEspecial?: string;
  obligadoContabilidad?: string;
  rise?: string;
  codDocModificado: string;  // '01'=Factura, '03'=Liquidación, etc.
  numDocModificado: string;  // 'NNN-NNN-NNNNNNNNN'
  fechaEmisionDocSustento: string; // DD/MM/AAAA
  totalSinImpuestos: number;
  valorModificacion: number;
  moneda?: string;
  totalConImpuestos: TotalImpuestoNC[];
  motivo: string;

  // detalles
  detalles: DetalleNC[];

  // infoAdicional
  infoAdicional?: CampoAdicional[];
}

export interface TotalImpuestoNC {
  codigo: string;
  codigoPorcentaje: string;
  baseImponible: number;
  valor: number;
}

export interface DetalleNC {
  codigoInterno?: string;
  codigoAdicional?: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuento?: number;
  precioTotalSinImpuesto: number;
  detallesAdicionales?: { nombre: string; valor: string }[];
  impuestos: ImpuestoDetalleNC[];
}

export interface ImpuestoDetalleNC {
  codigo: string;
  codigoPorcentaje: string;
  tarifa: number;
  baseImponible: number;
  valor: number;
}

export interface CampoAdicional {
  nombre: string;
  valor: string;
}
