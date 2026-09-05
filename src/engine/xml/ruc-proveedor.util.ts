import { create } from 'xmlbuilder2';

/**
 * Cumplimiento Resolución SRI NAC-DGERCGC26-00000027: todo comprobante electrónico
 * emitido a través de un proveedor de sistemas de facturación debe incluir el RUC
 * del proveedor en infoAdicional. Nombre de campo confirmado contra un comprobante
 * autorizado real de otro proveedor (Anexo 26 de la resolución).
 */
/** Límite de campoAdicional que acepta el SRI por comprobante. */
const MAX_CAMPOS_ADICIONALES = 15;

/**
 * Lee la config en cada llamada, no al cargar el módulo: ConfigModule.forRoot()
 * (que carga el .env vía dotenv) no corre hasta que NestFactory.create() arranca,
 * lo cual sucede DESPUÉS de que todo el árbol de imports ya se evaluó. Una
 * constante a nivel de módulo habría quedado congelada en `false`/`null` para
 * siempre, sin importar que el .env sí tuviera los valores correctos.
 */
function getConfig() {
  const rucProveedor = process.env.SRI_RUC_PROVEEDOR_SISTEMA || null;
  const campoNombre = process.env.SRI_RUC_PROVEEDOR_CAMPO_NOMBRE || 'RUC Proveedor';
  const enabled = process.env.INCLUDE_RUC_PROVEEDOR !== 'false' && !!rucProveedor;
  return { rucProveedor, campoNombre, enabled };
}

export interface CampoAdicional {
  nombre: string;
  valor: string;
}

/**
 * Agrega (o reemplaza) el campoAdicional del RUC proveedor en un arreglo infoAdicional
 * ya mapeado desde el DTO del cliente. Se usa en el path JSON (buildXmlData/buildRideData).
 */
export function withRucProveedor(campos?: CampoAdicional[]): CampoAdicional[] | undefined {
  const { rucProveedor, campoNombre, enabled } = getConfig();
  if (!enabled) return campos;

  const sinDuplicado = (campos || []).filter((c) => c.nombre !== campoNombre);
  const conProveedor = [{ nombre: campoNombre, valor: rucProveedor! }, ...sinDuplicado];

  // Si el cliente ya venía con 15 campos, se descarta el último suyo para no exceder el límite del SRI.
  return conProveedor.slice(0, MAX_CAMPOS_ADICIONALES);
}

/**
 * Inserta el campoAdicional del RUC proveedor directamente en un XML crudo sin firmar
 * (endpoint POST /documents/xml), creando el bloque infoAdicional si no existe.
 */
export function injectRucProveedorIntoRawXml(xml: string): string {
  const { rucProveedor, campoNombre, enabled } = getConfig();
  if (!enabled) return xml;

  const doc = create(xml);
  const root = doc.root();

  let infoAdicional = root.find((n) => n.node.nodeName === 'infoAdicional', false, false);
  if (!infoAdicional) {
    infoAdicional = root.ele('infoAdicional');
  } else {
    const yaExiste = infoAdicional.find(
      (n) => n.node.nodeName === 'campoAdicional'
        && (n.node as unknown as Element).getAttribute?.('nombre') === campoNombre,
      false, false,
    );
    if (yaExiste) return xml; // ya lo trae el cliente, no duplicar
  }

  infoAdicional.ele('campoAdicional', { nombre: campoNombre }).txt(rucProveedor!);

  return doc.end({ prettyPrint: true });
}
