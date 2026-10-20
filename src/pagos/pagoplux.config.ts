import { ConfigService } from '@nestjs/config';

/**
 * Datos de PagoPlux por ambiente (skill pagoplux). AutorizadorEC usa por ahora el
 * establecimiento de Mila (10078 en producción, 1168 en sandbox): Plux tiene un solo hook
 * por establecimiento, así que Mila recibe el aviso y nos lo reenvía firmado.
 */
const AMBIENTES = {
  sandbox: {
    script: 'https://sandbox-paybox.pagoplux.com/paybox/index_angular.js',
    ips: ['54.166.14.207'],
    email: 'info@veyzasoft.com',
  },
  prod: {
    script: 'https://paybox.pagoplux.com/paybox/index_angular.js',
    ips: ['3.131.229.160'],
    email: 'salazarmanuel6@gmail.com',
  },
} as const;

/** Prefijo de AutorizadorEC en PayboxExtras: "autorizadorec|<clientTxId>". */
export const PRODUCTO = 'autorizadorec';

export type ConfigPlux = ReturnType<typeof leerConfigPlux>;

export function leerConfigPlux(config: ConfigService) {
  const ambiente =
    config.get<string>('PAGOPLUX_AMBIENTE') === 'prod' ? 'prod' : 'sandbox';
  const amb = AMBIENTES[ambiente];
  const ipsRaw = (config.get<string>('PAGOPLUX_HOOK_IPS') ?? '').trim();
  // 'mila': avisos reenviados y firmados por Mila (establecimiento compartido)
  // 'plux': hook directo de Plux (cuando AutorizadorEC tenga su propio establecimiento)
  const avisos =
    config.get<string>('PAGOPLUX_AVISOS') === 'plux' ? 'plux' : 'mila';
  const reenvioSecreto = config.get<string>('PAGOPLUX_REENVIO_SECRETO') ?? '';
  const clientId = config.get<string>('PAGOPLUX_CLIENT_ID') ?? '';
  const secret = config.get<string>('PAGOPLUX_SECRET') ?? '';
  return {
    ambiente,
    produccion: ambiente === 'prod',
    habilitado: config.get<string>('PAGOPLUX_HABILITADO') === 'true',
    scriptUrl: config.get<string>('PAGOPLUX_SCRIPT_URL') || amb.script,
    email: config.get<string>('PAGOPLUX_EMAIL') || amb.email,
    nombre: config.get<string>('PAGOPLUX_NOMBRE') || 'VEYZASOFT',
    /** Monto mínimo que acepta el establecimiento (10078: $1,00). Con menos, el botón de Plux no abre. */
    montoMinimoCentavos: Math.round(
      Number(config.get<string>('PAGOPLUX_MONTO_MINIMO') || '1.00') * 100,
    ),
    avisos,
    reenvioSecreto,
    clientId,
    secret,
    /** null = sin filtro de IP (solo pruebas locales con PAGOPLUX_HOOK_IPS=off). */
    hookIps:
      ipsRaw.toLowerCase() === 'off'
        ? null
        : ipsRaw
          ? ipsRaw
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
          : [...amb.ips],
    /** Lo mínimo para cobrar y recibir avisos. */
    configurado:
      avisos === 'mila'
        ? reenvioSecreto.length >= 32
        : Boolean(clientId && secret),
  };
}
