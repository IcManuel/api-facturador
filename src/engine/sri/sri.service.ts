import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { CompanyEnv } from '../../entities/enums';
import {
  SRI_URLS,
  SRI_STATE_RECEIVED,
  SRI_STATE_AUTHORIZED,
} from './sri.constants';

export interface SriReceptionResult {
  accepted: boolean;
  state: string;
  messages: SriMessage[];
}

export interface SriAuthorizationResult {
  authorized: boolean;
  state: string;
  authorizationNumber: string | null;
  authorizedAt: string | null;
  authorizedXml: string | null;
  messages: SriMessage[];
}

export interface SriMessage {
  identifier: string;
  message: string;
  additionalInfo: string;
  type: string;
}

/**
 * Retryable network errors (not SRI logic errors — actual connection / infra failures).
 * Includes TLS errors from SRI presenting a misconfigured cert on their load balancer:
 * those are SRI-side incidents and typically auto-resolve within minutes.
 */
const RETRYABLE_CODES = [
  // Plain transport
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ECONNABORTED',
  // TLS / cert issues coming from SRI's infra (their problem, retry-able from our side)
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_HANDSHAKE_TIMEOUT',
];

/** Substrings on the error message that also indicate retryable transient failures */
const RETRYABLE_MESSAGE_HINTS = [
  'altnames', 'certificate', 'TLS', 'socket hang up', 'network error',
];

const MAX_NETWORK_RETRIES = 5; // 6 attempts total

/**
 * Circuit-breaker thresholds. Keeps the engine from hammering the SRI when
 * it's clearly down — drops the per-doc 5-min retry burn while the outage
 * lasts. State is per env (production/test) and per process.
 */
const CB_FAILURE_THRESHOLD = 4;     // failures within window to trip the breaker
const CB_WINDOW_MS = 5 * 60_000;    // 5-minute sliding window
const CB_OPEN_MS = 5 * 60_000;      // hold the breaker open for 5 min before probing
const CB_MAX_OPEN_MS = 30 * 60_000; // hard cap when consecutive probes also fail
const NETWORK_RETRY_DELAYS = [3000, 8000, 20000, 45000, 90000]; // ~3 min total before giving up

interface CircuitState {
  state: 'closed' | 'open' | 'half-open';
  openedAt: number;
  openMs: number;          // how long this open period lasts
  consecutiveOpens: number; // for exponential extension when probes keep failing
  failures: number[];      // timestamps of recent failures inside the sliding window
}

@Injectable()
export class SriService {
  private readonly logger = new Logger(SriService.name);

  /** Per-env circuit breaker state. Stops hammering the SRI during outages. */
  private readonly circuits: Record<string, CircuitState> = {
    production: this.initialCircuit(),
    test: this.initialCircuit(),
  };

  private initialCircuit(): CircuitState {
    return { state: 'closed', openedAt: 0, openMs: CB_OPEN_MS, consecutiveOpens: 0, failures: [] };
  }

  /** Snapshot for diagnostics/admin endpoints. */
  getCircuitStatus(): Record<string, {
    state: string;
    openedAt: string | null;
    msUntilProbe: number;
    recentFailures: number;
  }> {
    const out: ReturnType<SriService['getCircuitStatus']> = {};
    for (const [env, cb] of Object.entries(this.circuits)) {
      const elapsed = Date.now() - cb.openedAt;
      out[env] = {
        state: cb.state,
        openedAt: cb.openedAt ? new Date(cb.openedAt).toISOString() : null,
        msUntilProbe: cb.state === 'open' ? Math.max(0, cb.openMs - elapsed) : 0,
        recentFailures: cb.failures.length,
      };
    }
    return out;
  }

  private circuitFor(env: CompanyEnv): CircuitState {
    return this.circuits[env === CompanyEnv.PRODUCTION ? 'production' : 'test'];
  }

  /** Forzar el cierre del breaker (operación admin tras un incidente). */
  resetCircuit(envName?: 'production' | 'test'): void {
    const targets = envName ? [envName] : (['production', 'test'] as const);
    for (const t of targets) {
      this.circuits[t] = this.initialCircuit();
      this.logger.warn(`SRI circuit breaker manualmente CERRADO para ${t}`);
    }
  }

  /** Returns true when the circuit blocks the attempt; transitions to half-open if the open period has elapsed. */
  private shouldShortCircuit(cb: CircuitState): boolean {
    if (cb.state === 'closed') return false;
    const elapsed = Date.now() - cb.openedAt;
    if (cb.state === 'open' && elapsed >= cb.openMs) {
      cb.state = 'half-open';
      this.logger.log(`SRI circuit breaker → HALF-OPEN: probando con la siguiente petición`);
      return false; // let one attempt through as probe
    }
    return cb.state === 'open';
  }

  private recordFailure(cb: CircuitState, label: string): void {
    const now = Date.now();
    cb.failures = cb.failures.filter((t) => now - t < CB_WINDOW_MS);
    cb.failures.push(now);

    if (cb.state === 'half-open') {
      // Probe failed — extend the open period (capped).
      cb.consecutiveOpens += 1;
      cb.openMs = Math.min(CB_OPEN_MS * Math.pow(2, cb.consecutiveOpens), CB_MAX_OPEN_MS);
      cb.openedAt = now;
      cb.state = 'open';
      this.logger.warn(
        `SRI circuit breaker → OPEN (probe ${cb.consecutiveOpens} failed): cortando ${Math.round(cb.openMs / 60000)}min más`,
      );
      return;
    }

    if (cb.state === 'closed' && cb.failures.length >= CB_FAILURE_THRESHOLD) {
      cb.state = 'open';
      cb.openedAt = now;
      cb.openMs = CB_OPEN_MS;
      cb.consecutiveOpens = 1;
      this.logger.warn(
        `SRI circuit breaker → OPEN: ${cb.failures.length} fallos en ${Math.round(CB_WINDOW_MS / 60000)}min (${label}). ` +
          `Cortando intentos por ${Math.round(cb.openMs / 60000)}min.`,
      );
    }
  }

  private recordSuccess(cb: CircuitState): void {
    if (cb.state === 'closed') return;
    this.logger.log(`SRI circuit breaker → CLOSED: petición exitosa, retomando operación normal`);
    cb.state = 'closed';
    cb.openedAt = 0;
    cb.openMs = CB_OPEN_MS;
    cb.consecutiveOpens = 0;
    cb.failures = [];
  }

  /**
   * Send signed XML to SRI for validation (recepción).
   * SOAP call to validarComprobante. Retries on network failures.
   */
  async sendToReception(signedXml: string, env: CompanyEnv): Promise<SriReceptionResult> {
    const url = env === CompanyEnv.PRODUCTION
      ? SRI_URLS.production.reception
      : SRI_URLS.test.reception;

    const xmlBase64 = Buffer.from(signedXml, 'utf-8').toString('base64');

    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ec="http://ec.gob.sri.ws.recepcion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:validarComprobante>
      <xml>${xmlBase64}</xml>
    </ec:validarComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;

    const soapStart = Date.now();
    const responseData = await this.soapCallWithRetry(url, soapEnvelope, 'reception', env);
    const soapMs = Date.now() - soapStart;

    this.logger.debug(`SRI reception raw response:\n${responseData}`);
    const result = this.parseReceptionResponse(responseData);
    this.logger.log(`SRI reception [${soapMs}ms]: accepted=${result.accepted}, state=${result.state}, messages=${JSON.stringify(result.messages.map(m => ({ id: m.identifier, msg: m.message, info: m.additionalInfo })))}`);
    return result;
  }

  /**
   * Check authorization status of a document by access key.
   * SOAP call to autorizacionComprobante. Retries on network failures.
   */
  async checkAuthorization(accessKey: string, env: CompanyEnv): Promise<SriAuthorizationResult> {
    const url = env === CompanyEnv.PRODUCTION
      ? SRI_URLS.production.authorization
      : SRI_URLS.test.authorization;

    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ec="http://ec.gob.sri.ws.autorizacion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:autorizacionComprobante>
      <claveAccesoComprobante>${accessKey}</claveAccesoComprobante>
    </ec:autorizacionComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;

    const soapStart = Date.now();
    const responseData = await this.soapCallWithRetry(url, soapEnvelope, 'authorization', env);
    const soapMs = Date.now() - soapStart;

    const result = this.parseAuthorizationResponse(responseData);
    this.logger.log(`SRI authorization [${soapMs}ms]: state=${result.state}, authorized=${result.authorized}, authNum=${result.authorizationNumber ?? 'null'}, messages=${JSON.stringify(result.messages.map(m => ({ id: m.identifier, msg: m.message, info: m.additionalInfo })))}`);
    return result;
  }

  // ── SOAP call with network retry ──

  /**
   * Execute a SOAP call with automatic retry on network errors.
   * Only retries on transient network failures (ECONNRESET, ETIMEDOUT, etc.),
   * NOT on SRI logic errors (those are handled by the caller).
   */
  private async soapCallWithRetry(
    url: string,
    soapEnvelope: string,
    label: string,
    env: CompanyEnv,
  ): Promise<string> {
    const cb = this.circuitFor(env);

    // Short-circuit: if the breaker is open we don't even open a socket.
    // The job-level retry will pick it up later (5/15/45min/2h/6h backoff).
    if (this.shouldShortCircuit(cb)) {
      const min = Math.ceil((cb.openMs - (Date.now() - cb.openedAt)) / 60000);
      throw new Error(
        `SRI no disponible: incidente en curso (circuito abierto). El sistema reintentará automáticamente en ~${min} min.`,
      );
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
      try {
        const response = await axios.post(url.replace('?wsdl', ''), soapEnvelope, {
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': '',
          },
          timeout: 30000,
          // Accept any status to inspect the body ourselves
          validateStatus: () => true,
        });

        const data = typeof response.data === 'string' ? response.data : String(response.data);

        // Detect non-SOAP responses (HTML error pages, 5xx, etc.)
        if (response.status >= 500) {
          const isHtml = data.includes('<html') || data.includes('<!DOCTYPE');
          if (isHtml) {
            this.logger.warn(`SRI ${label}: HTTP ${response.status} with HTML response (attempt ${attempt + 1})`);
            if (attempt < MAX_NETWORK_RETRIES) {
              await this.sleep(NETWORK_RETRY_DELAYS[attempt] ?? 10000);
              continue;
            }
            throw new Error(`SRI no disponible (HTTP ${response.status}). El servicio del SRI puede estar en mantenimiento.`);
          }
        }

        // Detect SOAP faults
        if (data.includes('<soap:Fault') || data.includes('<soapenv:Fault') || data.includes('<Fault')) {
          const faultMsg = this.extractSoapFault(data);
          this.logger.warn(`SRI ${label}: SOAP Fault: ${faultMsg} (attempt ${attempt + 1})`);
          if (attempt < MAX_NETWORK_RETRIES) {
            await this.sleep(NETWORK_RETRY_DELAYS[attempt] ?? 10000);
            continue;
          }
          throw new Error(`SRI devolvió un error SOAP: ${faultMsg}`);
        }

        // Verify we got a valid SOAP response (not an empty body or garbage)
        // Check for SRI response wrapper tags — don't require <estado> as it may be
        // absent in legitimate responses (e.g., document not yet processed)
        const isSoapResponse = data.includes('Envelope') && (
          data.includes('Response') || data.includes('Respuesta')
        );
        if (!isSoapResponse) {
          this.logger.warn(`SRI ${label}: Invalid/empty response (attempt ${attempt + 1}): ${data.substring(0, 200)}`);
          if (attempt < MAX_NETWORK_RETRIES) {
            await this.sleep(NETWORK_RETRY_DELAYS[attempt] ?? 10000);
            continue;
          }
          throw new Error('SRI devolvió una respuesta vacía o inválida');
        }

        this.recordSuccess(cb);
        return data;
      } catch (error: any) {
        if (error instanceof AxiosError && this.isRetryableNetworkError(error)) {
          this.logger.warn(`SRI ${label}: Network error "${error.code}" (attempt ${attempt + 1}/${MAX_NETWORK_RETRIES + 1})`);
          lastError = error;
          if (attempt < MAX_NETWORK_RETRIES) {
            await this.sleep(NETWORK_RETRY_DELAYS[attempt] ?? 10000);
            continue;
          }
        }

        // Non-retryable error or exhausted retries — trip/extend the breaker.
        this.recordFailure(cb, label);

        if (error.response?.data) {
          this.logger.error(`SRI ${label} response body:\n${error.response.data}`);
        }

        const msg = lastError
          ? `Error de conexión con el SRI tras ${MAX_NETWORK_RETRIES + 1} intentos: ${lastError.message}`
          : `Error al comunicarse con el SRI: ${error.message}`;
        throw new Error(msg);
      }
    }

    throw new Error(`SRI ${label}: Agotados los reintentos de conexión`);
  }

  private isRetryableNetworkError(error: AxiosError): boolean {
    const cause: any = (error as any).cause;
    const codes = [error.code, cause?.code].filter(Boolean) as string[];
    if (codes.some((c) => RETRYABLE_CODES.includes(c))) return true;
    // No response received at all (connection level failure)
    if (!error.response && error.request) return true;
    // Message-based fallback for libraries that drop the code (e.g. some TLS errors)
    const msg = `${error.message || ''} ${cause?.message || ''}`.toLowerCase();
    if (RETRYABLE_MESSAGE_HINTS.some((h) => msg.includes(h.toLowerCase()))) return true;
    return false;
  }

  private extractSoapFault(xml: string): string {
    const faultString = xml.match(/<faultstring>([^<]*)<\/faultstring>/)?.[1];
    const detail = xml.match(/<detail>([^<]*)<\/detail>/)?.[1];
    return faultString ? `${faultString}${detail ? ' — ' + detail : ''}` : 'Error SOAP desconocido';
  }

  // ── Response parsers ──

  /**
   * Parse SRI reception SOAP response.
   */
  private parseReceptionResponse(xml: string): SriReceptionResult {
    const stateMatch = xml.match(/<estado>([^<]+)<\/estado>/);
    const state = stateMatch?.[1] ?? 'UNKNOWN';

    const messages = this.extractMessages(xml);

    return {
      accepted: state === SRI_STATE_RECEIVED,
      state,
      messages,
    };
  }

  /**
   * Parse SRI authorization SOAP response.
   */
  private parseAuthorizationResponse(xml: string): SriAuthorizationResult {
    const stateMatch = xml.match(/<estado>([^<]+)<\/estado>/);
    const state = stateMatch?.[1] ?? 'UNKNOWN';

    const authNumMatch = xml.match(/<numeroAutorizacion>([^<]+)<\/numeroAutorizacion>/);
    const authorizationNumber = authNumMatch?.[1] ?? null;

    const authDateMatch = xml.match(/<fechaAutorizacion>([^<]+)<\/fechaAutorizacion>/);
    const authorizedAt = authDateMatch?.[1] ?? null;

    // Tolerante a espacios/saltos de línea entre <comprobante> y el CDATA —
    // el SRI no siempre los devuelve pegados (bug detectado en incidente 2026-08-31).
    const compMatch = xml.match(/<comprobante>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/comprobante>/);
    const authorizedXml = compMatch?.[1] ?? null;

    const messages = this.extractMessages(xml);

    return {
      authorized: state === SRI_STATE_AUTHORIZED,
      state,
      authorizationNumber,
      authorizedAt,
      authorizedXml,
      messages,
    };
  }

  /**
   * Extract SRI message blocks from SOAP XML.
   * SRI uses `<mensaje>` both as a wrapper block and as an inner text field,
   * so we match outer blocks that contain `<identificador>` to avoid confusion.
   */
  private extractMessages(xml: string): SriMessage[] {
    const messages: SriMessage[] = [];

    const blockRegex = /<mensaje>\s*<identificador>([\s\S]*?)<\/tipo>\s*<\/mensaje>/g;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(xml)) !== null) {
      const block = match[0];
      messages.push({
        identifier: this.extractTag(block, 'identificador'),
        message: this.extractTag(block, 'mensaje'),
        additionalInfo: this.extractTag(block, 'informacionAdicional'),
        type: this.extractTag(block, 'tipo'),
      });
    }

    return messages;
  }

  private extractTag(xml: string, tag: string): string {
    const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match?.[1] ?? '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
