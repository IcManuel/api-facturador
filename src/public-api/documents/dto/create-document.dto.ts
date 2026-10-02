import {
  IsString, IsNotEmpty, IsNumber, IsOptional, IsArray,
  ValidateNested, Min, MaxLength, MinLength, ArrayMinSize,
  ArrayMaxSize, Matches, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Detalle adicional (per line item or infoAdicional) ──
export class DetAdicionalDto {
  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  nombre: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  valor: string;
}

// ── Tax detail (per line item) ──
export class ImpuestoDetalleDto {
  @ApiProperty({ description: 'Código impuesto SRI tabla 16: 2=IVA, 3=ICE, 5=IRBPNR' })
  @IsString()
  @Matches(/^[235]$/, { message: 'codigo debe ser 2 (IVA), 3 (ICE) o 5 (IRBPNR)' })
  codigo: string;

  @ApiProperty({ description: 'Código porcentaje SRI (tablas 17/18): 1-4 dígitos' })
  @IsString()
  @Matches(/^\d{1,4}$/, { message: 'codigoPorcentaje debe ser numérico de 1 a 4 dígitos' })
  codigoPorcentaje: string;

  @ApiProperty({ description: 'Tarifa del impuesto (ej: 15, 12, 0). Max 4 dígitos, 2 decimales' })
  @IsNumber()
  @Min(0)
  tarifa: number;

  @ApiProperty({ description: 'Base imponible. Max 14 dígitos (12 enteros, 2 decimales)' })
  @IsNumber()
  @Min(0)
  baseImponible: number;

  @ApiProperty({ description: 'Valor del impuesto. Max 14 dígitos (12 enteros, 2 decimales)' })
  @IsNumber()
  @Min(0)
  valor: number;
}

// ── Line item detail ──
export class DetalleDto {
  @ApiProperty({ description: 'Código principal del producto', maxLength: 25 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(25)
  codigoPrincipal: string;

  @ApiPropertyOptional({ maxLength: 25 })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  codigoAuxiliar?: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  descripcion: string;

  @ApiProperty({ description: 'Cantidad. Max 18 dígitos, hasta 6 decimales. Debe ser > 0' })
  @IsNumber()
  @Min(0.000001, { message: 'cantidad debe ser mayor a 0' })
  cantidad: number;

  @ApiProperty({ description: 'Precio unitario. Max 18 dígitos, hasta 6 decimales' })
  @IsNumber()
  @Min(0)
  precioUnitario: number;

  @ApiProperty({ description: 'Descuento del ítem. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  descuento: number;

  @ApiProperty({ description: 'Precio total sin impuesto. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  precioTotalSinImpuesto: number;

  @ApiPropertyOptional({ type: [DetAdicionalDto], description: 'Detalles adicionales del ítem (max 3)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'SRI permite máximo 3 detalles adicionales por ítem' })
  @ValidateNested({ each: true })
  @Type(() => DetAdicionalDto)
  detallesAdicionales?: DetAdicionalDto[];

  @ApiProperty({ type: [ImpuestoDetalleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImpuestoDetalleDto)
  @ArrayMinSize(1)
  impuestos: ImpuestoDetalleDto[];
}

// ── Total tax summary ──
export class TotalImpuestoDto {
  @ApiProperty({ description: 'Código impuesto SRI tabla 16: 2=IVA, 3=ICE, 5=IRBPNR' })
  @IsString()
  @Matches(/^[235]$/, { message: 'codigo debe ser 2 (IVA), 3 (ICE) o 5 (IRBPNR)' })
  codigo: string;

  @ApiProperty({ description: 'Código porcentaje SRI (tablas 17/18): 1-4 dígitos' })
  @IsString()
  @Matches(/^\d{1,4}$/, { message: 'codigoPorcentaje debe ser numérico de 1 a 4 dígitos' })
  codigoPorcentaje: string;

  @ApiPropertyOptional({ description: 'Descuento adicional. Solo aplica para código impuesto 2 (IVA). Max 14 dígitos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  descuentoAdicional?: number;

  @ApiProperty({ description: 'Base imponible. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  baseImponible: number;

  @ApiPropertyOptional({
    description:
      'Tarifa del impuesto (ej: 15 para IVA 15%). Opcional: si no se envía, se toma del catálogo del SRI según codigoPorcentaje.',
    example: 15,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarifa?: number;

  @ApiProperty({ description: 'Valor del impuesto. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  valor: number;
}

// ── Reimbursement tax detail ──
export class ImpuestoReembolsoDto {
  @ApiProperty({ description: 'Código impuesto SRI tabla 16: 2=IVA, 3=ICE, 5=IRBPNR' })
  @IsString()
  @Matches(/^[235]$/, { message: 'codigo debe ser 2 (IVA), 3 (ICE) o 5 (IRBPNR)' })
  codigo: string;

  @ApiProperty({ description: 'Código porcentaje SRI (tablas 17/18): 1-4 dígitos' })
  @IsString()
  @Matches(/^\d{1,4}$/, { message: 'codigoPorcentaje debe ser numérico de 1 a 4 dígitos' })
  codigoPorcentaje: string;

  @ApiProperty({ description: 'Tarifa del impuesto. Min 1, Max 4 dígitos / 2 decimales' })
  @IsNumber()
  @Min(0)
  tarifa: number;

  @ApiProperty({ description: 'Base imponible del reembolso. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  baseImponibleReembolso: number;

  @ApiProperty({ description: 'Impuesto del reembolso. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  impuestoReembolso: number;
}

// ── Reimbursement detail ──
export class ReembolsoDetalleDto {
  @ApiProperty({ description: 'Tipo identificación proveedor reembolso (tabla 6): 04=RUC, 05=CI, 06=Pasaporte, 07=Consumidor Final, 08=Id. Exterior' })
  @IsString()
  @IsIn(['04', '05', '06', '07', '08'], {
    message: 'tipoIdentificacionProveedorReembolso debe ser: 04, 05, 06, 07 u 08',
  })
  tipoIdentificacionProveedorReembolso: string;

  @ApiProperty({ description: 'Identificación del proveedor reembolso', maxLength: 13 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(13)
  identificacionProveedorReembolso: string;

  @ApiProperty({ description: 'Código país proveedor reembolso (tabla 25). 3 dígitos' })
  @IsString()
  @Matches(/^\d{3}$/, { message: 'codPaisProveedorReembolso debe ser numérico de 3 dígitos' })
  codPaisProveedorReembolso: string;

  @ApiProperty({ description: 'Tipo proveedor reembolso (tabla 26): 01=Persona Natural, 02=Sociedad' })
  @IsString()
  @IsIn(['01', '02'], { message: 'tipoProveedorReembolso debe ser 01 (Persona Natural) o 02 (Sociedad)' })
  tipoProveedorReembolso: string;

  @ApiProperty({ description: 'Código documento reembolso (catálogo ATS). Min 2, Max 3 dígitos' })
  @IsString()
  @Matches(/^\d{2,3}$/, { message: 'codDocReembolso debe ser numérico de 2 a 3 dígitos' })
  codDocReembolso: string;

  @ApiProperty({ description: 'Establecimiento documento reembolso. 3 dígitos' })
  @IsString()
  @Matches(/^\d{3}$/, { message: 'estabDocReembolso debe ser numérico de 3 dígitos' })
  estabDocReembolso: string;

  @ApiProperty({ description: 'Punto emisión documento reembolso. 3 dígitos' })
  @IsString()
  @Matches(/^\d{3}$/, { message: 'ptoEmiDocReembolso debe ser numérico de 3 dígitos' })
  ptoEmiDocReembolso: string;

  @ApiProperty({ description: 'Secuencial documento reembolso. 9 dígitos' })
  @IsString()
  @Matches(/^\d{9}$/, { message: 'secuencialDocReembolso debe ser numérico de exactamente 9 dígitos' })
  secuencialDocReembolso: string;

  @ApiProperty({ description: 'Fecha emisión documento reembolso DD/MM/AAAA' })
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaEmisionDocReembolso debe tener formato DD/MM/AAAA' })
  fechaEmisionDocReembolso: string;

  @ApiProperty({ description: 'Número autorización documento reembolso. 10, 37 o 49 dígitos' })
  @IsString()
  @Matches(/^\d{10}$|^\d{37}$|^\d{49}$/, {
    message: 'numeroautorizacionDocReemb debe ser numérico de 10, 37 o 49 dígitos',
  })
  numeroautorizacionDocReemb: string;

  @ApiProperty({ type: [ImpuestoReembolsoDto], description: 'Impuestos del reembolso' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImpuestoReembolsoDto)
  @ArrayMinSize(1)
  detalleImpuestos: ImpuestoReembolsoDto[];
}

// ── Payment method ──
export class PagoDto {
  @ApiProperty({ description: 'Forma de pago SRI tabla 24 (2 dígitos: 01, 15, 16, 17, 18, 19, 20, 21)' })
  @IsString()
  @Matches(/^\d{2}$/, { message: 'formaPago debe ser numérico de 2 dígitos (tabla 24 SRI)' })
  formaPago: string;

  @ApiProperty({ description: 'Total del pago. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  total: number;

  @ApiPropertyOptional({ description: 'Plazo del pago. Max 14 dígitos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plazo?: number;

  @ApiPropertyOptional({ description: 'Unidad de tiempo (dias, meses, etc)', maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  unidadTiempo?: string;
}

// ── Retención tax detail ──
export class ImpuestoRetencionDto {
  @ApiProperty({ description: 'Código impuesto retención: 1=Renta, 2=IVA, 6=ISD' })
  @IsString()
  @IsIn(['1', '2', '6'], { message: 'codigo debe ser 1 (Renta), 2 (IVA) o 6 (ISD)' })
  codigo: string;

  @ApiProperty({ description: 'Código de retención SRI (ej: 303, 312, 332). Max 4 dígitos' })
  @IsString()
  @Matches(/^\d{1,4}$/, { message: 'codigoRetencion debe ser numérico de 1 a 4 dígitos' })
  codigoRetencion: string;

  @ApiProperty({ description: 'Base imponible. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  baseImponible: number;

  @ApiProperty({ description: 'Porcentaje a retener (ej: 1, 2, 8, 10, 30, 70, 100)' })
  @IsNumber()
  @Min(0)
  porcentajeRetener: number;

  @ApiProperty({ description: 'Valor retenido. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  valorRetenido: number;

  @ApiProperty({ description: 'Código documento sustento: 01=Factura, 03=Liquidación, 04=NC, 05=ND' })
  @IsString()
  @Matches(/^\d{2}$/, { message: 'codDocSustento debe ser numérico de 2 dígitos' })
  codDocSustento: string;

  @ApiProperty({ description: 'Número documento sustento NNN-NNN-NNNNNNNNN', example: '001-001-000000042' })
  @IsString()
  @Matches(/^\d{3}-\d{3}-\d{9}$/, { message: 'numDocSustento debe tener formato NNN-NNN-NNNNNNNNN' })
  numDocSustento: string;

  @ApiProperty({ description: 'Fecha emisión documento sustento DD/MM/AAAA' })
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaEmisionDocSustento debe tener formato DD/MM/AAAA' })
  fechaEmisionDocSustento: string;

  @ApiPropertyOptional({ description: 'Código sustento tributario (tabla 2 SRI). Default: 01', example: '01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/, { message: 'codSustento debe ser numérico de 2 dígitos' })
  codSustento?: string;

  @ApiPropertyOptional({ description: 'Número autorización documento sustento (10, 37 o 49 dígitos)' })
  @IsOptional()
  @IsString()
  numAutDocSustento?: string;

  @ApiPropertyOptional({ description: 'Fecha registro contable DD/MM/AAAA. Default: fechaEmisionDocSustento' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaRegistroContable debe tener formato DD/MM/AAAA' })
  fechaRegistroContable?: string;

  @ApiPropertyOptional({ description: 'Pago local/exterior: 01=local, 02=exterior. Default: 01' })
  @IsOptional()
  @IsString()
  @IsIn(['01', '02'], { message: 'pagoLocExt debe ser 01 (local) o 02 (exterior)' })
  pagoLocExt?: string;

  @ApiPropertyOptional({ description: 'Total sin impuestos del documento sustento' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalSinImpuestos?: number;

  @ApiPropertyOptional({ description: 'Importe total del documento sustento' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  importeTotal?: number;

  @ApiPropertyOptional({
    type: 'array',
    description: 'Impuestos del documento sustento (IVA/ICE del comprobante original). Se genera automáticamente si no se proporciona.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImpuestoDocSustentoDto)
  impuestosDocSustento?: ImpuestoDocSustentoDto[];

  @ApiPropertyOptional({ description: 'Forma de pago del documento sustento (2 dígitos tabla 24 SRI). Default: 20' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/, { message: 'formaPago debe ser numérico de 2 dígitos' })
  formaPago?: string;

  @ApiPropertyOptional({ description: 'Total del pago del documento sustento' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalPago?: number;
}

// ── Retención v2.0.0: impuesto del documento sustento ──
export class ImpuestoDocSustentoDto {
  @ApiProperty({ description: 'Código impuesto doc sustento: 2=IVA, 3=ICE, 5=IRBPNR' })
  @IsString()
  codImpuestoDocSustento: string;

  @ApiProperty({ description: 'Código porcentaje (tabla SRI: 0, 2, 3, 4, etc.)' })
  @IsString()
  codigoPorcentaje: string;

  @ApiProperty({ description: 'Base imponible del impuesto' })
  @IsNumber()
  @Min(0)
  baseImponible: number;

  @ApiProperty({ description: 'Tarifa del impuesto (ej: 0, 12, 15)' })
  @IsNumber()
  @Min(0)
  tarifa: number;

  @ApiProperty({ description: 'Valor del impuesto' })
  @IsNumber()
  @Min(0)
  valorImpuesto: number;
}

// ── Guía de Remisión: detalle de item transportado ──
export class DetalleDestinatarioGRDto {
  @ApiPropertyOptional({ description: 'Código interno del producto', maxLength: 25 })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  codigoInterno?: string;

  @ApiPropertyOptional({ description: 'Código adicional del producto', maxLength: 25 })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  codigoAdicional?: string;

  @ApiProperty({ description: 'Descripción del producto', maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  descripcion: string;

  @ApiProperty({ description: 'Cantidad transportada. Max 18 dígitos, hasta 6 decimales' })
  @IsNumber()
  @Min(0.000001, { message: 'cantidad debe ser mayor a 0' })
  cantidad: number;
}

// ── Guía de Remisión: destinatario ──
export class DestinatarioGRDto {
  @ApiProperty({ description: 'Identificación del destinatario (RUC/CI)', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  identificacionDestinatario: string;

  @ApiProperty({ description: 'Razón social del destinatario', maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  razonSocialDestinatario: string;

  @ApiProperty({ description: 'Dirección del destinatario', maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  dirDestinatario: string;

  @ApiProperty({ description: 'Motivo del traslado', maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  motivoTraslado: string;

  @ApiPropertyOptional({ description: 'Documento aduanero único', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  docAduaneroUnico?: string;

  @ApiPropertyOptional({ description: 'Código establecimiento destino (3 dígitos)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}$/, { message: 'codEstabDestino debe ser numérico de 3 dígitos' })
  codEstabDestino?: string;

  @ApiPropertyOptional({ description: 'Ruta de transporte', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  ruta?: string;

  @ApiPropertyOptional({ description: 'Código documento sustento (01=Factura, etc.)', example: '01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/, { message: 'codDocSustento debe ser numérico de 2 dígitos' })
  codDocSustento?: string;

  @ApiPropertyOptional({ description: 'Número documento sustento NNN-NNN-NNNNNNNNN', example: '001-001-000000042' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}-\d{3}-\d{9}$/, { message: 'numDocSustento debe tener formato NNN-NNN-NNNNNNNNN' })
  numDocSustento?: string;

  @ApiPropertyOptional({ description: 'Número autorización del documento sustento', maxLength: 49 })
  @IsOptional()
  @IsString()
  @MaxLength(49)
  numAutDocSustento?: string;

  @ApiPropertyOptional({ description: 'Fecha emisión documento sustento DD/MM/AAAA' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaEmisionDocSustento debe tener formato DD/MM/AAAA' })
  fechaEmisionDocSustento?: string;

  @ApiProperty({ type: [DetalleDestinatarioGRDto], description: 'Items transportados para este destinatario' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DetalleDestinatarioGRDto)
  @ArrayMinSize(1)
  detalles: DetalleDestinatarioGRDto[];
}

// ── Nota de Débito motivo ──
export class MotivoNDDto {
  @ApiProperty({ description: 'Razón/descripción del cargo adicional', maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  razon: string;

  @ApiProperty({ description: 'Valor del cargo. Max 14 dígitos' })
  @IsNumber()
  @Min(0)
  valor: number;
}

// ── Main document creation DTO ──
export class CreateDocumentDto {
  @ApiProperty({
    description: 'Tipo de documento SRI (tabla 3)',
    enum: ['01', '03', '04', '05', '06', '07'],
  })
  @IsString()
  @IsIn(['01', '03', '04', '05', '06', '07'], {
    message: 'tipoDocumento debe ser: 01 (Factura), 03 (Liquidación), 04 (Nota Crédito), 05 (Nota Débito), 06 (Guía Remisión), 07 (Retención)',
  })
  tipoDocumento: string;

  @ApiProperty({ description: 'Fecha de emisión DD/MM/AAAA', example: '06/03/2026' })
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, {
    message: 'fechaEmision debe tener formato DD/MM/AAAA',
  })
  fechaEmision: string;

  @ApiPropertyOptional({
    description:
      'Establecimiento emisor (3 dígitos). Si no se envía, se usa el establecimiento principal de la empresa, ' +
      'que es el comportamiento por defecto. Cada establecimiento lleva su propia numeración.',
    example: '002',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}$/, { message: 'establecimiento debe ser numérico de 3 dígitos (ej: "002")' })
  establecimiento?: string;

  @ApiPropertyOptional({ description: 'Punto de emisión (default: primer punto configurado)', example: '001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}$/, { message: 'puntoEmision debe ser numérico de 3 dígitos' })
  puntoEmision?: string;

  // ── Buyer info ──
  @ApiProperty({ description: 'Tipo identificación comprador SRI tabla 6: 04=RUC, 05=CI, 06=Pasaporte, 07=Consumidor Final, 08=Identificación Exterior' })
  @IsString()
  @IsIn(['04', '05', '06', '07', '08'], {
    message: 'tipoIdentificacionComprador debe ser: 04 (RUC), 05 (Cédula), 06 (Pasaporte), 07 (Consumidor Final), 08 (Id. Exterior)',
  })
  tipoIdentificacionComprador: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  razonSocialComprador: string;

  @ApiProperty({ description: 'Identificación del comprador', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  identificacionComprador: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  direccionComprador?: string;

  @ApiPropertyOptional({ description: 'Email del comprador (campo plataforma, no SRI)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  emailComprador?: string;

  // ── Totals (required for factura, optional for retención) ──
  @ApiPropertyOptional({ description: 'Total sin impuestos. Max 14 dígitos (12 enteros, 2 decimales). Requerido para facturas.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalSinImpuestos?: number;

  @ApiPropertyOptional({ description: 'Total descuento. Max 14 dígitos. Requerido para facturas.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalDescuento?: number;

  @ApiPropertyOptional({ type: [TotalImpuestoDto], description: 'Requerido para facturas.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TotalImpuestoDto)
  @ArrayMinSize(1)
  totalConImpuestos?: TotalImpuestoDto[];

  @ApiPropertyOptional({ default: 0, description: 'Propina. Max 14 dígitos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  propina?: number;

  @ApiPropertyOptional({ description: 'Importe total. Max 14 dígitos. Requerido para facturas.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  importeTotal?: number;

  @ApiPropertyOptional({ default: 'DOLAR', maxLength: 15 })
  @IsOptional()
  @IsString()
  @MaxLength(15)
  moneda?: string;

  // ── Payments (required for factura, not used for retención) ──
  @ApiPropertyOptional({ type: [PagoDto], description: 'Requerido para facturas.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PagoDto)
  @ArrayMinSize(1)
  pagos?: PagoDto[];

  // ── Line items (required for factura, not used for retención) ──
  @ApiPropertyOptional({ type: [DetalleDto], description: 'Requerido para facturas.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DetalleDto)
  @ArrayMinSize(1)
  detalles?: DetalleDto[];

  // ── Additional info (optional, max 15 per SRI) ──
  @ApiPropertyOptional({ type: [DetAdicionalDto], description: 'Campos adicionales (max 15)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15, { message: 'SRI permite máximo 15 campos en infoAdicional' })
  @ValidateNested({ each: true })
  @Type(() => DetAdicionalDto)
  infoAdicional?: DetAdicionalDto[];

  // ── Optional SRI fields ──
  @ApiPropertyOptional({ description: 'Dirección del establecimiento emisor', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  dirEstablecimiento?: string;

  @ApiPropertyOptional({ description: 'Contribuyente especial Nro. Resolución', minLength: 3, maxLength: 13 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(13)
  contribuyenteEspecial?: string;

  @ApiPropertyOptional({ description: 'Obligado a llevar contabilidad', enum: ['SI', 'NO'] })
  @IsOptional()
  @IsString()
  @IsIn(['SI', 'NO'], { message: 'obligadoContabilidad debe ser SI o NO' })
  obligadoContabilidad?: string;

  @ApiPropertyOptional({ description: 'Régimen RIMPE', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  contribuyenteRimpe?: string;

  @ApiPropertyOptional({ description: 'Agente de retención Nro. Resolución' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  agenteRetencion?: string;

  @ApiPropertyOptional({ description: 'Guía de remisión asociada (formato NNN-NNN-NNNNNNNNN)', example: '001-001-000000001' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}-\d{3}-\d{9}$/, { message: 'guiaRemision debe tener formato NNN-NNN-NNNNNNNNN' })
  guiaRemision?: string;

  // ── Reimbursement (factura por reembolso, codDocReemb=41) ──
  @ApiPropertyOptional({
    type: [ReembolsoDetalleDto],
    description: 'Detalles de reembolso. Si se incluye, la factura se genera como factura por reembolso (codDocReemb=41). ' +
      'Los totales de reembolso (totalComprobantesReembolso, totalBaseImponibleReembolso, totalImpuestoReembolso) ' +
      'se calculan automáticamente a partir de los detalles.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReembolsoDetalleDto)
  @ArrayMinSize(1)
  reembolsos?: ReembolsoDetalleDto[];

  @ApiPropertyOptional({ description: 'Valor retención IVA presuntivo. Max 14 dígitos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valorRetIva?: number;

  @ApiPropertyOptional({ description: 'Valor retención renta presuntivo. Max 14 dígitos' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valorRetRenta?: number;

  @ApiPropertyOptional({
    description: 'Secuencial del documento (9 dígitos). Solo requerido si sequentialMode="client".',
    example: '000000015',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,9}$/, { message: 'secuencial debe ser numérico de 1 a 9 dígitos' })
  secuencial?: string;

  @ApiPropertyOptional({
    description: 'Clave de acceso de 49 dígitos. Solo requerido en modo "client".',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{49}$/, { message: 'claveAcceso debe ser numérico de exactamente 49 dígitos' })
  claveAcceso?: string;

  @ApiPropertyOptional({ description: 'Clave de idempotencia (evita duplicados)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  // ══════════════════════════════════════════════════════════════
  //  NOTA DE CRÉDITO / NOTA DE DÉBITO SHARED FIELDS (04/05)
  // ══════════════════════════════════════════════════════════════

  @ApiPropertyOptional({
    description: 'Código documento que se modifica (tabla 3): 01=Factura, 03=Liquidación, etc. Requerido para NC y ND.',
    example: '01',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/, { message: 'codDocModificado debe ser numérico de 2 dígitos' })
  codDocModificado?: string;

  @ApiPropertyOptional({
    description: 'Número del documento que se modifica NNN-NNN-NNNNNNNNN. Requerido para NC y ND.',
    example: '001-001-000000042',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}-\d{3}-\d{9}$/, { message: 'numDocModificado debe tener formato NNN-NNN-NNNNNNNNN' })
  numDocModificado?: string;

  @ApiPropertyOptional({
    description: 'Fecha emisión del documento sustento DD/MM/AAAA. Requerido para NC y ND.',
    example: '01/03/2026',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaEmisionDocSustento debe tener formato DD/MM/AAAA' })
  fechaEmisionDocSustento?: string;

  @ApiPropertyOptional({
    description: 'Motivo/razón de la modificación. Max 300 caracteres. Requerido para notas de crédito.',
    example: 'DEVOLUCION DE MERCADERIA',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;

  @ApiPropertyOptional({
    description: 'Valor de la modificación (importe total NC). Max 14 dígitos. Requerido para notas de crédito.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valorModificacion?: number;

  // ══════════════════════════════════════════════════════════════
  //  NOTA DE DÉBITO-SPECIFIC FIELDS (tipoDocumento=05)
  // ══════════════════════════════════════════════════════════════

  @ApiPropertyOptional({
    description: 'Valor total de la nota de débito (subtotal + impuestos). Max 14 dígitos. Requerido para notas de débito.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valorTotal?: number;

  @ApiPropertyOptional({
    type: () => [MotivoNDDto],
    description: 'Motivos/razones de la nota de débito. Requerido para notas de débito (tipoDocumento=05).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MotivoNDDto)
  @ArrayMinSize(1)
  motivos?: MotivoNDDto[];

  // ══════════════════════════════════════════════════════════════
  //  GUÍA DE REMISIÓN-SPECIFIC FIELDS (tipoDocumento=06)
  // ══════════════════════════════════════════════════════════════

  @ApiPropertyOptional({
    description: 'Dirección de partida del transporte. Requerido para guías de remisión.',
    maxLength: 300,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  dirPartida?: string;

  @ApiPropertyOptional({
    description: 'Razón social del transportista. Requerido para guías de remisión.',
    maxLength: 300,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  razonSocialTransportista?: string;

  @ApiPropertyOptional({
    description: 'Tipo identificación transportista (04=RUC, 05=CI, 06=Pasaporte). Requerido para guías de remisión.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['04', '05', '06', '07', '08'], {
    message: 'tipoIdentificacionTransportista debe ser: 04 (RUC), 05 (Cédula), 06 (Pasaporte), 07 (Consumidor Final), 08 (Id. Exterior)',
  })
  tipoIdentificacionTransportista?: string;

  @ApiPropertyOptional({
    description: 'RUC/CI del transportista. Requerido para guías de remisión.',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  rucTransportista?: string;

  @ApiPropertyOptional({
    description: 'Fecha inicio transporte DD/MM/AAAA. Requerido para guías de remisión.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaIniTransporte debe tener formato DD/MM/AAAA' })
  fechaIniTransporte?: string;

  @ApiPropertyOptional({
    description: 'Fecha fin transporte DD/MM/AAAA. Requerido para guías de remisión.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, { message: 'fechaFinTransporte debe tener formato DD/MM/AAAA' })
  fechaFinTransporte?: string;

  @ApiPropertyOptional({
    description: 'Placa del vehículo de transporte. Requerido para guías de remisión.',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  placa?: string;

  @ApiPropertyOptional({
    type: () => [DestinatarioGRDto],
    description: 'Destinatarios con items transportados. Requerido para guías de remisión (tipoDocumento=06).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DestinatarioGRDto)
  @ArrayMinSize(1)
  destinatarios?: DestinatarioGRDto[];

  // ══════════════════════════════════════════════════════════════
  //  RETENCIÓN-SPECIFIC FIELDS (tipoDocumento=07)
  // ══════════════════════════════════════════════════════════════

  @ApiPropertyOptional({
    description: 'Período fiscal MM/AAAA. Requerido para retenciones.',
    example: '03/2026',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{4}$/, { message: 'periodoFiscal debe tener formato MM/AAAA' })
  periodoFiscal?: string;

  @ApiPropertyOptional({
    type: [ImpuestoRetencionDto],
    description: 'Impuestos retenidos. Requerido para retenciones (tipoDocumento=07).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImpuestoRetencionDto)
  @ArrayMinSize(1)
  impuestosRetencion?: ImpuestoRetencionDto[];

  @ApiPropertyOptional({
    description: 'Tipo sujeto retenido: 01=persona natural, 02=sociedad. Se deriva automáticamente si no se proporciona.',
    example: '02',
  })
  @IsOptional()
  @IsString()
  @IsIn(['01', '02'], { message: 'tipoSujetoRetenido debe ser 01 (persona natural) o 02 (sociedad)' })
  tipoSujetoRetenido?: string;

  @ApiPropertyOptional({
    description: 'Parte relacionada: SI o NO. Default: NO',
    example: 'NO',
  })
  @IsOptional()
  @IsString()
  @IsIn(['SI', 'NO'], { message: 'parteRel debe ser SI o NO' })
  parteRel?: string;
}
