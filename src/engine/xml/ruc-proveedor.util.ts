import { create } from 'xmlbuilder2';

/**
 * Cumplimiento Resolución SRI NAC-DGERCGC26-00000027: todo comprobante electrónico
 * emitido a través de un proveedor de sistemas de facturación debe incluir el RUC
 * del proveedor en infoAdicional. Nombre de campo confirmado contra un comprobante
 * autorizado real de otro proveedor (Anexo 26 de la resolución).
 */
const RUC_PROVEEDOR = process.env.SRI_RUC_PROVEEDOR_SISTEMA || null;
const CAMPO_NOMBRE = process.env.SRI_RUC_PROVEEDOR_CAMPO_NOMBRE || 'RUC Proveedor';
const ENABLED = process.env.INCLUDE_RUC_PROVEEDOR !== 'false' && !!RUC_PROVEEDOR;

/** Límite de campoAdicional que acepta el SRI por comprobante. */
const MAX_CAMPOS_ADICIONALES = 15;

export interface CampoAdicional {
  nombre: string;
  valor: string;
}

/**
 * Agrega (o reemplaza) el campoAdicional del RUC proveedor en un arreglo infoAdicional
 * ya mapeado desde el DTO del cliente. Se usa en el path JSON (buildXmlData/buildRideData).
 */
export function withRucProveedor(campos?: CampoAdicional[]): CampoAdicional[] | undefined {
  if (!ENABLED) return campos;

  const sinDuplicado = (campos || []).filter((c) => c.nombre !== CAMPO_NOMBRE);
  const conProveedor = [{ nombre: CAMPO_NOMBRE, valor: RUC_PROVEEDOR! }, ...sinDuplicado];

  // Si el cliente ya venía con 15 campos, se descarta el último suyo para no exceder el límite del SRI.
  return conProveedor.slice(0, MAX_CAMPOS_ADICIONALES);
}

/**
 * Inserta el campoAdicional del RUC proveedor directamente en un XML crudo sin firmar
 * (endpoint POST /documents/xml), creando el bloque infoAdicional si no existe.
 */
export function injectRucProveedorIntoRawXml(xml: string): string {
  if (!ENABLED) return xml;

  const doc = create(xml);
  const root = doc.root();

  let infoAdicional = root.find((n) => n.node.nodeName === 'infoAdicional', false, false);
  if (!infoAdicional) {
    infoAdicional = root.ele('infoAdicional');
  } else {
    const yaExiste = infoAdicional.find(
      (n) => n.node.nodeName === 'campoAdicional'
        && (n.node as unknown as Element).getAttribute?.('nombre') === CAMPO_NOMBRE,
      false, false,
    );
    if (yaExiste) return xml; // ya lo trae el cliente, no duplicar
  }

  infoAdicional.ele('campoAdicional', { nombre: CAMPO_NOMBRE }).txt(RUC_PROVEEDOR!);

  return doc.end({ prettyPrint: true });
}
