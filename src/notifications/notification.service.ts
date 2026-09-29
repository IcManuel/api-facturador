import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/* ────────── Interfaces ────────── */

export interface DocRejectedData {
  companyName: string;
  companyRuc: string;
  companyEmail: string | null;
  notificationEmail: string | null;
  docType: string;
  sequential: string;
  accessKey: string;
  errors: { code: string; message: string; detail?: string }[];
}

export interface CertExpiryData {
  companyName: string;
  companyRuc: string;
  companyEmail: string | null;
  notificationEmail: string | null;
  certSubject: string | null;
  expiresAt: string; // YYYY-MM-DD
  daysLeft: number;
  expired: boolean;
}

export interface LimitReachedData {
  companyName: string;
  companyRuc: string;
  companyEmail: string | null;
  notificationEmail: string | null;
  docLimit: number;
  docsUsed: number;
  overageEnabled: boolean;
}

export interface WarningMessageData {
  accountName: string;
  accountEmail: string;
  companyEmails: { email: string | null; notificationEmail: string | null }[];
  message: string;
}

export interface AccountBlockedData {
  accountName: string;
  accountEmail: string;
  companyEmails: { email: string | null; notificationEmail: string | null }[];
}

export interface BillingInvoiceData {
  accountName: string;
  accountEmail: string;
  companyEmails: { email: string | null; notificationEmail: string | null }[];
  year: number;
  month: number;
  docsTotal: number;
  basePrice: number;
  overageDocs: number;
  overageTotal: number;
  total: number;
}

export interface NewTrialRegistrationData {
  accountName: string;
  accountRuc: string;
  accountEmail: string;
  adminName: string;
  trialEndsAt: string; // YYYY-MM-DD
}

export interface OverduePaymentData {
  accountName: string;
  accountEmail: string;
  companyEmails: { email: string | null; notificationEmail: string | null }[];
  year: number;
  month: number;
  total: number;
  paidAmount: number;
  daysSinceDue: number;
}

/* ────────── Service ────────── */

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private transporter: nodemailer.Transporter;
  private from: string;
  private isDev: boolean;

  private readonly docTypeLabels: Record<string, string> = {
    '01': 'Factura',
    '03': 'Liquidación de Compras',
    '04': 'Nota de Crédito',
    '05': 'Nota de Débito',
    '06': 'Guía de Remisión',
    '07': 'Retención',
  };

  constructor(private readonly config: ConfigService) {
    const host = config.get('SMTP_HOST');
    this.from = config.get('SMTP_FROM', 'FacturaEC <noreply@facturaec.com>');
    this.isDev = !host;

    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(config.get('SMTP_PORT', 587)),
        secure: config.get('SMTP_SECURE', 'false') === 'true',
        auth: { user: config.get('SMTP_USER'), pass: config.get('SMTP_PASS') },
      });
    } else {
      this.logger.warn('SMTP not configured — notification emails logged to console');
      this.transporter = nodemailer.createTransport({ jsonTransport: true });
    }
  }

  /* ────────── 1. Document Rejected ────────── */

  async sendDocumentRejected(data: DocRejectedData): Promise<void> {
    const label = this.docTypeLabels[data.docType] || 'Documento';
    const errorRows = data.errors
      .map(
        (e) =>
          `<tr>
            <td style="padding:6px 10px;border:1px solid #e9ecef;font-family:monospace;font-size:12px">${e.code}</td>
            <td style="padding:6px 10px;border:1px solid #e9ecef;font-size:13px">${e.message}</td>
            <td style="padding:6px 10px;border:1px solid #e9ecef;font-size:12px;color:#666">${e.detail || '—'}</td>
          </tr>`,
      )
      .join('');

    const html = this.wrap(`
      <h2 style="color:#dc2626;margin-bottom:8px">${label} Rechazada por el SRI</h2>
      <p style="color:#555;font-size:14px">
        La ${label.toLowerCase()} <strong>${data.sequential}</strong> de <strong>${data.companyName}</strong> (${data.companyRuc})
        fue rechazada por el SRI.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr style="background:#fef2f2">
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600;width:35%">Clave de Acceso</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-size:11px;word-break:break-all">${data.accessKey}</td>
        </tr>
      </table>
      <h3 style="color:#333;font-size:14px;margin-bottom:8px">Errores del SRI:</h3>
      <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px">
        <tr style="background:#f8f9fa">
          <th style="padding:6px 10px;border:1px solid #e9ecef;text-align:left">Código</th>
          <th style="padding:6px 10px;border:1px solid #e9ecef;text-align:left">Mensaje</th>
          <th style="padding:6px 10px;border:1px solid #e9ecef;text-align:left">Detalle</th>
        </tr>
        ${errorRows}
      </table>
      <p style="color:#555;font-size:13px">
        Corrija los errores y reenvíe el documento.
      </p>
    `);

    const recipients = this.collectRecipients(data.companyEmail, data.notificationEmail);
    await this.send(recipients, `[RECHAZADO] ${label} ${data.sequential} — ${data.companyName}`, html);
  }

  /* ────────── 2 & 3. Certificate Expiry ────────── */

  async sendCertificateExpiry(data: CertExpiryData): Promise<void> {
    const isExpired = data.expired;
    const color = isExpired ? '#dc2626' : '#f59e0b';
    const title = isExpired
      ? 'Firma Electrónica CADUCADA'
      : `Firma Electrónica por Caducar (${data.daysLeft} días)`;
    const urgency = isExpired
      ? 'Su firma electrónica ya ha caducado. No podrá emitir documentos electrónicos hasta que la renueve.'
      : `Su firma electrónica caduca en <strong>${data.daysLeft} días</strong> (${data.expiresAt}). Renuévela antes de que caduque para evitar interrupciones.`;

    const html = this.wrap(`
      <h2 style="color:${color};margin-bottom:8px">${title}</h2>
      <p style="color:#555;font-size:14px">
        Empresa: <strong>${data.companyName}</strong> (${data.companyRuc})
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:40%">Titular</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.certSubject || '—'}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Fecha de Vencimiento</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;color:${color};font-weight:600">${data.expiresAt}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Estado</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;color:${color};font-weight:600">${isExpired ? 'CADUCADA' : `Caduca en ${data.daysLeft} días`}</td>
        </tr>
      </table>
      <p style="color:#555;font-size:14px">${urgency}</p>
    `);

    const subject = isExpired
      ? `[URGENTE] Firma Electrónica CADUCADA — ${data.companyName}`
      : `[ALERTA] Firma Electrónica caduca en ${data.daysLeft} días — ${data.companyName}`;

    const recipients = this.collectRecipients(data.companyEmail, data.notificationEmail);
    await this.send(recipients, subject, html);
  }

  /* ────────── 4. Document Limit Reached ────────── */

  async sendLimitReached(data: LimitReachedData): Promise<void> {
    const overageMsg = data.overageEnabled
      ? 'Tiene habilitado el consumo de <strong>extras</strong>. Los documentos adicionales se facturarán como excedentes según su plan.'
      : '<strong>No tiene habilitado extras.</strong> No podrá emitir más documentos hasta el siguiente período. Contacte al administrador para habilitar excedentes o cambiar de plan.';

    const html = this.wrap(`
      <h2 style="color:#f59e0b;margin-bottom:8px">Límite de Documentos Alcanzado</h2>
      <p style="color:#555;font-size:14px">
        La empresa <strong>${data.companyName}</strong> (${data.companyRuc}) ha alcanzado su límite mensual de documentos.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:40%">Documentos Usados</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.docsUsed}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Límite del Plan</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.docLimit}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Extras Habilitado</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.overageEnabled ? 'Sí' : 'No'}</td>
        </tr>
      </table>
      <p style="color:#555;font-size:14px">${overageMsg}</p>
    `);

    const recipients = this.collectRecipients(data.companyEmail, data.notificationEmail);
    await this.send(recipients, `[ALERTA] Límite de documentos alcanzado — ${data.companyName}`, html);
  }

  /* ────────── 5. Warning Message Created ────────── */

  async sendWarningMessage(data: WarningMessageData): Promise<void> {
    const html = this.wrap(`
      <h2 style="color:#f59e0b;margin-bottom:8px">Mensaje de Advertencia</h2>
      <p style="color:#555;font-size:14px">
        Se ha registrado un mensaje de advertencia en la cuenta <strong>${data.accountName}</strong>:
      </p>
      <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:16px 0">
        <p style="color:#92400e;font-size:14px;margin:0">${data.message}</p>
      </div>
      <p style="color:#555;font-size:13px">
        Si tiene consultas, comuníquese con el administrador de la plataforma.
      </p>
    `);

    const recipients = this.collectAccountRecipients(data.accountEmail, data.companyEmails);
    await this.send(recipients, `[ADVERTENCIA] ${data.accountName} — Mensaje de advertencia`, html);
  }

  /* ────────── 6. Account Blocked ────────── */

  async sendAccountBlocked(data: AccountBlockedData): Promise<void> {
    const html = this.wrap(`
      <h2 style="color:#dc2626;margin-bottom:8px">Cuenta Bloqueada</h2>
      <p style="color:#555;font-size:14px">
        La cuenta <strong>${data.accountName}</strong> ha sido <strong style="color:#dc2626">bloqueada</strong>.
      </p>
      <p style="color:#555;font-size:14px">
        Mientras la cuenta esté bloqueada, no se podrán emitir documentos electrónicos.
      </p>
      <p style="color:#555;font-size:13px">
        Para más información, comuníquese con el administrador de la plataforma.
      </p>
    `);

    const recipients = this.collectAccountRecipients(data.accountEmail, data.companyEmails);
    await this.send(recipients, `[BLOQUEADA] Cuenta ${data.accountName} bloqueada`, html);
  }

  /* ────────── 7. Billing Invoice Generated ────────── */

  async sendBillingInvoice(data: BillingInvoiceData): Promise<void> {
    const monthNames = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const period = `${monthNames[data.month]} ${data.year}`;

    const html = this.wrap(`
      <h2 style="color:#1a1a2e;margin-bottom:8px">Factura de Cobro Generada</h2>
      <p style="color:#555;font-size:14px">
        Se ha generado la factura de cobro para la cuenta <strong>${data.accountName}</strong>
        correspondiente al período <strong>${period}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:45%">Período</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${period}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Documentos Emitidos</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.docsTotal}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Precio Base</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">$${data.basePrice.toFixed(2)}</td>
        </tr>
        ${data.overageDocs > 0 ? `
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Documentos Extra</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.overageDocs}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Total Extras</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">$${data.overageTotal.toFixed(2)}</td>
        </tr>` : ''}
        <tr>
          <td style="padding:8px 12px;background:#1a1a2e;color:#fff;border:1px solid #e9ecef;font-weight:600;font-size:15px">TOTAL</td>
          <td style="padding:8px 12px;background:#1a1a2e;color:#fff;border:1px solid #e9ecef;font-weight:600;font-size:15px">$${data.total.toFixed(2)}</td>
        </tr>
      </table>
    `);

    const recipients = this.collectAccountRecipients(data.accountEmail, data.companyEmails);
    await this.send(recipients, `[FACTURA] ${period} — ${data.accountName} — $${data.total.toFixed(2)}`, html);
  }

  /* ────────── 8. Overdue Payment Reminder ────────── */

  async sendOverduePayment(data: OverduePaymentData): Promise<void> {
    const monthNames = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const period = `${monthNames[data.month]} ${data.year}`;
    const pending = data.total - data.paidAmount;

    const html = this.wrap(`
      <h2 style="color:#dc2626;margin-bottom:8px">Pago Vencido</h2>
      <p style="color:#555;font-size:14px">
        La cuenta <strong>${data.accountName}</strong> tiene un pago pendiente correspondiente al período <strong>${period}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:45%">Período</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${period}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Total</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">$${data.total.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Pagado</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">$${data.paidAmount.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#fef2f2;border:1px solid #e9ecef;font-weight:600;color:#dc2626">Saldo Pendiente</td>
          <td style="padding:8px 12px;background:#fef2f2;border:1px solid #e9ecef;font-weight:600;color:#dc2626">$${pending.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Días Vencido</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;color:#dc2626">${data.daysSinceDue} días</td>
        </tr>
      </table>
      <p style="color:#555;font-size:13px">
        Realice el pago a la brevedad posible para evitar la suspensión del servicio.
      </p>
    `);

    const recipients = this.collectAccountRecipients(data.accountEmail, data.companyEmails);
    await this.send(recipients, `[VENCIDO] Pago pendiente ${period} — ${data.accountName} — $${pending.toFixed(2)}`, html);
  }

  /* ────────── 9. New Trial Registration (to superadmins) ────────── */

  async sendNewTrialRegistration(recipients: string[], data: NewTrialRegistrationData): Promise<void> {
    const html = this.wrap(`
      <h2 style="color:#2563eb;margin-bottom:8px">Nuevo Registro — Periodo de Prueba</h2>
      <p style="color:#555;font-size:14px">
        Se ha registrado una nueva cuenta en la plataforma con un periodo de prueba de <strong>5 días</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:40%">Empresa</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.accountName}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">RUC</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-family:monospace">${data.accountRuc}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Email</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.accountEmail}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Administrador</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.adminName}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#eff6ff;border:1px solid #e9ecef;font-weight:600;color:#2563eb">Trial Expira</td>
          <td style="padding:8px 12px;background:#eff6ff;border:1px solid #e9ecef;font-weight:600;color:#2563eb">${data.trialEndsAt}</td>
        </tr>
      </table>
      <p style="color:#555;font-size:13px">
        Contacte al prospecto dentro de los próximos 5 días para completar la activación.
      </p>
    `);

    await this.send(
      recipients,
      `[NUEVO REGISTRO] ${data.accountName} (${data.accountRuc}) — Periodo de prueba 5 días`,
      html,
    );
  }

  /* ────────── Helpers ────────── */

  private collectRecipients(companyEmail: string | null, notificationEmail: string | null): string[] {
    const set = new Set<string>();
    if (companyEmail) set.add(companyEmail);
    if (notificationEmail) set.add(notificationEmail);
    return Array.from(set);
  }

  private collectAccountRecipients(
    accountEmail: string,
    companyEmails: { email: string | null; notificationEmail: string | null }[],
  ): string[] {
    const set = new Set<string>();
    set.add(accountEmail);
    for (const c of companyEmails) {
      if (c.email) set.add(c.email);
      if (c.notificationEmail) set.add(c.notificationEmail);
    }
    return Array.from(set);
  }

  /* ────────── System Error Alert (superadmin) ────────── */

  async sendSystemErrorAlert(data: {
    documentId: number;
    accessKey: string;
    sequential: string;
    docType: string;
    companyName: string;
    companyRuc: string;
    env: string;
    errorMessage: string;
    errorDetail?: string | null;
    failedAt: Date;
  }): Promise<void> {
    const recipients = this.getSystemErrorRecipients();
    if (recipients.length === 0) {
      this.logger.warn('No SYSTEM_ERROR_NOTIFY_EMAILS configured — system error alert not sent');
      return;
    }

    const label = this.docTypeLabels[data.docType] || 'Documento';
    const adminUrl = `${this.config.get('FRONTEND_URL', 'https://panel.autorizadorec.com')}/admin/documents`;
    const stackHead = (data.errorDetail || '').split('\n').slice(0, 6).join('\n');

    const html = this.wrap(`
      <h2 style="color:#dc2626;margin-bottom:8px">⚠️ Error de sistema en emisión</h2>
      <p style="color:#555;font-size:14px">
        El documento <strong>${label} ${data.sequential}</strong> de
        <strong>${data.companyName}</strong> (${data.companyRuc}) falló durante el procesamiento
        por un error de sistema (no de validación del SRI).
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr style="background:#fef2f2">
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600;width:35%">Documento ID</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.documentId}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">Ambiente</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.env}</td>
        </tr>
        <tr style="background:#fef2f2">
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">Clave de acceso</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-size:11px;word-break:break-all">${data.accessKey}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">Mensaje</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;color:#dc2626;font-size:12px">${this.escapeHtml(data.errorMessage)}</td>
        </tr>
        <tr style="background:#fef2f2">
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">Cuándo</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${data.failedAt.toISOString()}</td>
        </tr>
      </table>
      ${
        stackHead
          ? `<pre style="background:#f8f9fa;border:1px solid #e9ecef;padding:10px;border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word">${this.escapeHtml(stackHead)}</pre>`
          : ''
      }
      <p style="color:#555;font-size:13px;margin-top:16px">
        Ver detalle: <a href="${adminUrl}" style="color:#2563eb">${adminUrl}</a>
      </p>
    `);

    await this.send(recipients, `[SYS] ${label} ${data.sequential} — ${data.companyName} — ${data.env}`, html);
  }

  /* ────────── SRI Incident Alert (superadmin) ────────── */

  async sendSriIncidentAlert(data: {
    systemErrorDocs: number;
    windowMinutes: number;
    sampleMessages: string[];
  }): Promise<void> {
    const recipients = this.getSystemErrorRecipients();
    if (recipients.length === 0) return;

    const samples = data.sampleMessages
      .slice(0, 5)
      .map((m) => `<li style="font-size:12px;color:#555">${this.escapeHtml(m)}</li>`)
      .join('');

    const html = this.wrap(`
      <h2 style="color:#dc2626;margin-bottom:8px">🚨 Posible incidente del SRI</h2>
      <p style="color:#555;font-size:14px">
        Se detectaron <strong>${data.systemErrorDocs} documentos</strong> con errores de sistema
        en los últimos <strong>${data.windowMinutes} minutos</strong>. Esto suele indicar que el
        servicio del SRI está caído, lento o con problemas de certificado.
      </p>
      <p style="color:#555;font-size:13px">Los documentos se reintentan automáticamente; no se requiere acción inmediata salvo monitorear.</p>
      ${samples ? `<ul style="margin:12px 0">${samples}</ul>` : ''}
      <p style="color:#999;font-size:11px">Esta alerta no se repetirá en la próxima hora aunque continúen los errores.</p>
    `);

    await this.send(recipients, `[INCIDENTE SRI] ${data.systemErrorDocs} documentos con error de sistema`, html);
  }

  private getSystemErrorRecipients(): string[] {
    const raw = this.config.get<string>('SYSTEM_ERROR_NOTIFY_EMAILS', 'salazarmanuel6@gmail.com');
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async send(recipients: string[], subject: string, html: string): Promise<void> {
    if (recipients.length === 0) {
      this.logger.warn(`No recipients for notification: ${subject}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: recipients.join(', '),
        subject,
        html,
      });

      if (this.isDev) {
        this.logger.log(`[DEV EMAIL] To: ${recipients.join(', ')} | Subject: ${subject}`);
      } else {
        this.logger.log(`Notification sent to ${recipients.join(', ')}: ${subject}`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to send notification to ${recipients.join(', ')}: ${err.message}`);
    }
  }

  private wrap(body: string): string {
    return `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        ${body}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:11px;text-align:center">FacturaEC — Facturación Electrónica Ecuador</p>
      </div>
    `;
  }

  /* ────────── Reporte diario de cobros (interno) ────────── */

  async sendCollectionsReport(
    recipients: string[],
    data: {
      date: string;
      periodStart: string;
      periodEnd: string;
      accounts: Array<{
        accountName: string;
        accountEmail: string;
        accountPhone?: string | null;
        cycleDay: number;
        total: number;
        companies: Array<{
          companyName: string;
          companyRuc: string;
          planName: string;
          planTier: string;
          base: number;
          docsAuthorized: number;
          overageDocs: number;
          overageAmount: number;
          subtotal: number;
        }>;
      }>;
      totalDueToday: number;
      overdue: Array<{
        accountName: string;
        year: number;
        month: number;
        status: string;
        balance: number;
      }>;
      totalOverdue: number;
    },
  ): Promise<void> {
    const money = (n: number) => `$${n.toFixed(2)}`;
    const fecha = new Date(`${data.date}T12:00:00`).toLocaleDateString('es-EC', {
      day: 'numeric', month: 'long', year: 'numeric',
    });

    const accountBlocks = data.accounts
      .map((a) => {
        const detalle = a.companies
          .map((c) => {
            const concepto =
              c.planTier === 'payperuse'
                ? `${c.overageDocs} comprobante(s) autorizado(s) × ${money(c.overageDocs ? c.overageAmount / c.overageDocs : 0)}`
                : c.overageDocs > 0
                  ? `Cuota ${money(c.base)} + ${c.overageDocs} excedente(s) ${money(c.overageAmount)}`
                  : `Cuota ${money(c.base)}`;
            return `
              <tr>
                <td style="padding:4px 8px;font-size:12px">${this.escapeHtml(c.companyName)}<br>
                  <span style="color:#888">${this.escapeHtml(c.companyRuc)}</span></td>
                <td style="padding:4px 8px;font-size:12px">${this.escapeHtml(c.planName)}</td>
                <td style="padding:4px 8px;font-size:12px">${concepto}</td>
                <td style="padding:4px 8px;font-size:12px;text-align:right"><b>${money(c.subtotal)}</b></td>
              </tr>`;
          })
          .join('');

        return `
          <div style="border:1px solid #eee;border-radius:8px;padding:12px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between">
              <b style="font-size:14px">${this.escapeHtml(a.accountName)}</b>
              <b style="font-size:16px;color:#16a34a">${money(a.total)}</b>
            </div>
            <div style="color:#666;font-size:12px;margin-bottom:8px">
              ${this.escapeHtml(a.accountEmail)}${a.accountPhone ? ` · ${this.escapeHtml(a.accountPhone)}` : ''} · corte día ${a.cycleDay}
            </div>
            <table style="width:100%;border-collapse:collapse">${detalle}</table>
          </div>`;
      })
      .join('');

    const sinCobros = `
      <p style="font-size:14px;color:#666">Hoy no hay ninguna cuenta que corte. Nada que cobrar.</p>`;

    const overdueBlock = data.overdue.length
      ? `
        <h3 style="font-size:14px;margin-top:24px">Saldos de períodos anteriores (${money(data.totalOverdue)})</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          ${data.overdue
            .map(
              (o) => `
            <tr>
              <td style="padding:4px 8px">${this.escapeHtml(o.accountName)}</td>
              <td style="padding:4px 8px;color:#888">${String(o.month).padStart(2, '0')}/${o.year}</td>
              <td style="padding:4px 8px;color:${o.status === 'overdue' ? '#dc2626' : '#888'}">${o.status}</td>
              <td style="padding:4px 8px;text-align:right"><b>${money(o.balance)}</b></td>
            </tr>`,
            )
            .join('')}
        </table>`
      : '';

    const html = this.wrap(`
      <h2 style="font-size:18px;margin-bottom:4px">Cobros de hoy — ${fecha}</h2>
      <p style="color:#666;font-size:13px;margin-top:0">
        Ciclo facturado: ${data.periodStart} al ${data.periodEnd}
      </p>
      <p style="font-size:15px">
        <b>${data.accounts.length}</b> cuenta(s) por cobrar ·
        <b style="color:#16a34a">${money(data.totalDueToday)}</b>
      </p>
      ${data.accounts.length ? accountBlocks : sinCobros}
      ${overdueBlock}
    `);

    const subject = data.accounts.length
      ? `Cobros de hoy: ${data.accounts.length} cuenta(s) — ${money(data.totalDueToday)}`
      : 'Cobros de hoy: ninguno';

    await this.send(recipients, subject, html);
  }

  /* ────────── Recordatorio de pago consolidado (una cuenta, todos sus períodos) ────────── */

  async sendPaymentReminder(data: {
    accountName: string;
    accountEmail: string;
    companyEmails: Array<{ email: string | null; notificationEmail: string | null }>;
    periods: Array<{ year: number; month: number; balance: number }>;
    total: number;
  }): Promise<void> {
    const monthNames = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
      'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    const rows = data.periods
      .map(
        (p) => `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e9ecef">${monthNames[p.month]} ${p.year}</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;text-align:right">$${p.balance.toFixed(2)}</td>
        </tr>`,
      )
      .join('');

    const html = this.wrap(`
      <h2 style="margin-bottom:8px">Pago pendiente</h2>
      <p style="color:#555;font-size:14px">
        Hola, le escribimos de AutorizadorEC. La cuenta <strong>${this.escapeHtml(data.accountName)}</strong>
        tiene ${data.periods.length === 1 ? 'un período pendiente' : `${data.periods.length} períodos pendientes`} de pago.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <th style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;text-align:left">Período</th>
          <th style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;text-align:right">Valor</th>
        </tr>
        ${rows}
        <tr>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">Total</td>
          <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600;text-align:right">$${data.total.toFixed(2)}</td>
        </tr>
      </table>
      <p style="color:#555;font-size:13px">
        Para coordinar el pago, responda a este correo o escríbanos por WhatsApp y le enviamos los datos.
        Si ya realizó el pago, ignore este mensaje.
      </p>
    `);

    const recipients = this.collectAccountRecipients(data.accountEmail, data.companyEmails);
    await this.send(
      recipients,
      `Pago pendiente — ${data.accountName} — $${data.total.toFixed(2)}`,
      html,
    );
  }
}
