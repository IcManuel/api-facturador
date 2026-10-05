/**
 * SRI Error Code Classification.
 *
 * The SRI returns numeric error codes in its SOAP responses.
 * Each error implies a different recovery strategy.
 */

export enum SriErrorAction {
  /** Error in the payload — user must fix and resend (correctable) */
  REJECT = 'reject',
  /** Transient SRI issue — retry the same request later */
  RETRY = 'retry',
  /** Document already exists at SRI — skip to authorization check */
  SKIP_TO_AUTH = 'skip_to_auth',
  /** Document was already authorized — just fetch the authorization */
  ALREADY_AUTHORIZED = 'already_authorized',
  /** Access key is burned — need to regenerate key and resend */
  NEED_NEW_KEY = 'need_new_key',
  /** Fatal system error — needs manual intervention */
  FATAL = 'fatal',
}

interface SriErrorDef {
  action: SriErrorAction;
  description: string;
  /** If true, this error may resolve itself with a retry */
  transient: boolean;
}

/**
 * Known SRI error codes and their classification.
 * Source: SRI technical documentation + field experience.
 */
export const SRI_ERROR_MAP: Record<string, SriErrorDef> = {
  // -- Transient / SRI-side --
  '69': {
    action: SriErrorAction.RETRY,
    description: 'ERROR EN EL PROCESO DE COMPROBANTES — SRI internal error',
    transient: true,
  },

  // -- SRI processing reception (NOT yet received — must poll until RECIBIDA) --
  '70': {
    action: SriErrorAction.RETRY,
    description: 'CLAVE DE ACCESO EN PROCESAMIENTO — SRI is processing reception, poll until RECIBIDA',
    transient: true,
  },

  // -- Document already fully received at SRI --
  '43': {
    action: SriErrorAction.SKIP_TO_AUTH,
    description: 'CLAVE DE ACCESO REGISTRADA — SRI already received this document',
    transient: false,
  },
  // Error 45 = SECUENCIAL REGISTRADO: el SRI ya tiene OTRO comprobante con ese
  // número (tipo + establecimiento + punto + secuencial), con otra clave de
  // acceso. Típico cuando el emisor ya usó ese número desde otro sistema.
  // Esta clave nunca va a autorizarse: hay que rechazar y usar otro secuencial.
  '45': {
    action: SriErrorAction.REJECT,
    description: 'SECUENCIAL REGISTRADO — ese número ya fue usado en el SRI con otra clave de acceso',
    transient: false,
  },

  // -- XML structure / schema validation error --
  '35': {
    action: SriErrorAction.REJECT,
    description: 'ARCHIVO NO CUMPLE ESTRUCTURA XML',
    transient: false,
  },

  // -- Access key burned (received but returned/rejected) --
  '36': {
    action: SriErrorAction.NEED_NEW_KEY,
    description: 'CLAVE DE ACCESO REGISTRADA Y DEVUELTA — need new access key',
    transient: false,
  },

  // -- Payload / validation errors (user must fix) --
  '28': {
    action: SriErrorAction.REJECT,
    description: 'NÚMERO DE RUC NO EXISTE',
    transient: false,
  },
  '34': {
    action: SriErrorAction.REJECT,
    description: 'ERROR EN ESTRUCTURA DEL XML',
    transient: false,
  },
  '39': {
    action: SriErrorAction.REJECT,
    description: 'IDENTIFICACIÓN DEL RECEPTOR NO VÁLIDA',
    transient: false,
  },
  '47': {
    action: SriErrorAction.REJECT,
    description: 'EMISOR NO ENCONTRADO',
    transient: false,
  },
  '48': {
    action: SriErrorAction.REJECT,
    description: 'EMISOR SUSPENDIDO',
    transient: false,
  },
  '52': {
    action: SriErrorAction.REJECT,
    description: 'ERROR EN CÁLCULO DE TOTALES',
    transient: false,
  },
  '56': {
    action: SriErrorAction.REJECT,
    description: 'ESTABLECIMIENTO NO REGISTRADO EN SRI',
    transient: false,
  },
  '65': {
    action: SriErrorAction.REJECT,
    description: 'FECHA DE EMISIÓN POSTERIOR A LA FECHA ACTUAL',
    transient: false,
  },
  '67': {
    action: SriErrorAction.REJECT,
    description: 'SECUENCIAL REGISTRADO — ya existe un documento con ese secuencial',
    transient: false,
  },
};

/**
 * Classify an SRI error code. Returns the action to take.
 * Unknown errors default to REJECT (assume user error).
 */
export function classifySriError(code: string): SriErrorDef {
  return SRI_ERROR_MAP[code] ?? {
    action: SriErrorAction.REJECT,
    description: `Error SRI desconocido (código ${code})`,
    transient: false,
  };
}

/**
 * Given an array of SRI messages, determine the dominant action.
 * Priority: ALREADY_AUTHORIZED > SKIP_TO_AUTH > NEED_NEW_KEY > RETRY > REJECT > FATAL
 */
export function classifySriMessages(messages: Array<{ identifier: string }>): SriErrorAction {
  const actions = messages.map((m) => classifySriError(m.identifier).action);

  if (actions.includes(SriErrorAction.ALREADY_AUTHORIZED)) return SriErrorAction.ALREADY_AUTHORIZED;
  if (actions.includes(SriErrorAction.SKIP_TO_AUTH)) return SriErrorAction.SKIP_TO_AUTH;
  if (actions.includes(SriErrorAction.NEED_NEW_KEY)) return SriErrorAction.NEED_NEW_KEY;
  if (actions.includes(SriErrorAction.RETRY)) return SriErrorAction.RETRY;
  if (actions.includes(SriErrorAction.FATAL)) return SriErrorAction.FATAL;

  return SriErrorAction.REJECT;
}
