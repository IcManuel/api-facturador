import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface DocumentEmailData {
  buyerName: string;
  buyerEmail: string;
  companyName: string;
  /** Nombre comercial del emisor. Se usa como remitente visible del correo. */
  companyTradeName?: string | null;
  /** Correo del emisor. Si viene, las respuestas del comprador le llegan a él. */
  companyEmail?: string | null;
  companyRuc: string;
  docType: string;
  sequential: string;
  authNumber: string;
  authDate: string;
  totalAmount: string;
  rideBuffer?: Buffer;
  xmlBuffer?: Buffer;
}

export interface CompanyDocumentEmailData {
  companyEmail: string;
  companyName: string;
  /** Nombre comercial del emisor. Se usa como remitente visible del correo. */
  companyTradeName?: string | null;
  companyRuc: string;
  docType: string;
  sequential: string;
  authNumber: string;
  authDate: string;
  totalAmount: string;
  buyerName: string;
  buyerId: string;
  rideBuffer?: Buffer;
  xmlBuffer?: Buffer;
}

/** Servidor de correo propio de una empresa (SMTP personalizado). */
export interface CompanySender {
  transporter: nodemailer.Transporter;
  from: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    const host = config.get('SMTP_HOST');

    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(config.get('SMTP_PORT', 587)),
        secure: config.get('SMTP_SECURE', 'false') === 'true',
        auth: {
          user: config.get('SMTP_USER'),
          pass: config.get('SMTP_PASS'),
        },
      });
    } else {
      // Dev fallback: log to console
      this.logger.warn('SMTP not configured — emails will be logged to console');
      this.transporter = nodemailer.createTransport({
        jsonTransport: true,
      });
    }
  }

  async sendPasswordReset(to: string, name: string, resetUrl: string): Promise<void> {
    const from = this.config.get('SMTP_FROM', 'AutorizadorEC <noreply@autorizadorec.com>');

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a2e;margin-bottom:8px">Recuperar Contraseña</h2>
        <p style="color:#555;font-size:14px">Hola <strong>${name}</strong>,</p>
        <p style="color:#555;font-size:14px">
          Recibimos una solicitud para restablecer tu contraseña en AutorizadorEC.
          Haz clic en el siguiente enlace para crear una nueva contraseña:
        </p>
        <div style="text-align:center;margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;padding:12px 32px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">
            Restablecer Contraseña
          </a>
        </div>
        <p style="color:#888;font-size:12px">
          Este enlace expira en 15 minutos. Si no solicitaste este cambio, ignora este correo.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:11px;text-align:center">
          <a href="https://autorizadorec.com" style="color:#aaa;text-decoration:none">AutorizadorEC</a> — Facturación Electrónica Ecuador
        </p>
      </div>
    `;

    try {
      const result = await this.transporter.sendMail({
        from,
        to,
        subject: 'Recuperar contraseña — AutorizadorEC',
        html,
      });

      // In dev mode (jsonTransport), log the email
      if (!this.config.get('SMTP_HOST')) {
        const parsed = JSON.parse(result.message);
        this.logger.log(`[DEV EMAIL] To: ${to} | Subject: ${parsed.subject}`);
        this.logger.log(`[DEV EMAIL] Reset URL: ${resetUrl}`);
      } else {
        this.logger.log(`Password reset email sent to ${to}`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to send email to ${to}: ${err.message}`);
      throw err;
    }
  }


  /**
   * Remitente con el nombre del emisor: el cliente final ve el nombre de la
   * empresa que le factura, no el de la plataforma. La dirección de correo
   * sigue siendo la configurada en SMTP_FROM.
   */
  private fromWithName(displayName?: string | null): string {
    const configured = this.config.get('SMTP_FROM', 'AutorizadorEC <noreply@autorizadorec.com>');
    if (!displayName) return configured;

    const match = configured.match(/<([^>]+)>/);
    const address = match ? match[1] : configured;
    const safeName = displayName.replace(/["\\]/g, '').trim();
    if (!safeName) return configured;

    return `"${safeName}" <${address}>`;
  }

  /**
   * Envía por el SMTP propio de la empresa si lo tiene. Si ese servidor falla,
   * el correo sale igual por el de la plataforma: el comprobante no se debe perder.
   */
  private async deliver(mail: nodemailer.SendMailOptions, sender?: CompanySender | null): Promise<'company' | 'platform'> {
    if (sender) {
      try {
        await sender.transporter.sendMail({ ...mail, from: sender.from });
        return 'company';
      } catch (err: any) {
        this.logger.warn(`Company SMTP failed for ${mail.to}, falling back to platform SMTP: ${err.message}`);
      }
    }
    await this.transporter.sendMail(mail);
    return 'platform';
  }

  /** Pie de los correos que ve el cliente final. */
  private footer(companyName: string): string {
    return `
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:11px;text-align:center">
          ${companyName} — Documento generado por
          <a href="https://autorizadorec.com" style="color:#aaa;text-decoration:underline">AutorizadorEC</a>
        </p>`;
  }

  async sendDocumentAuthorized(data: DocumentEmailData, sender?: CompanySender | null): Promise<void> {
    const from = this.fromWithName(data.companyTradeName || data.companyName);

    const docTypeLabels: Record<string, string> = {
      '01': 'Factura',
      '04': 'Nota de Crédito',
      '05': 'Nota de Débito',
      '06': 'Guía de Remisión',
      '07': 'Retención',
    };
    const docTypeLabel = docTypeLabels[data.docType] || 'Documento';

    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a2e;margin-bottom:8px">${docTypeLabel} Electrónica Autorizada</h2>
        <p style="color:#555;font-size:14px">Estimado/a <strong>${data.buyerName}</strong>,</p>
        <p style="color:#555;font-size:14px">
          Le informamos que su ${docTypeLabel.toLowerCase()} ha sido autorizada por el SRI.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:45%">Emisor</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.companyName}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">RUC</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.companyRuc}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Secuencial</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.sequential}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">N° Autorización</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef;font-size:11px;word-break:break-all">${data.authNumber}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Fecha Autorización</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.authDate}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Total</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">$${data.totalAmount}</td>
          </tr>
        </table>
        <p style="color:#555;font-size:13px">
          Adjunto encontrará el RIDE (PDF) y el comprobante electrónico (XML) autorizados.
        </p>
        ${this.footer(data.companyName)}
      </div>
    `;

    const attachments: nodemailer.SendMailOptions['attachments'] = [];
    if (data.rideBuffer) {
      attachments.push({
        filename: `${data.sequential.replace(/-/g, '')}.pdf`,
        content: data.rideBuffer,
        contentType: 'application/pdf',
      });
    }
    if (data.xmlBuffer) {
      attachments.push({
        filename: `${data.sequential.replace(/-/g, '')}.xml`,
        content: data.xmlBuffer,
        contentType: 'application/xml',
      });
    }

    try {
      const via = await this.deliver({
        from,
        replyTo: data.companyEmail || undefined,
        to: data.buyerEmail,
        subject: `${docTypeLabel} ${data.sequential} — ${data.companyName}`,
        html,
        attachments,
      }, sender);

      if (!this.config.get('SMTP_HOST') && via === 'platform') {
        this.logger.log(`[DEV EMAIL] Document authorized to: ${data.buyerEmail} | ${data.sequential}`);
      } else {
        this.logger.log(`Document email sent to ${data.buyerEmail} for ${data.sequential} (via ${via} SMTP)`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to send document email to ${data.buyerEmail}: ${err.message}`);
      // Don't throw — email failure shouldn't block the authorization flow
    }
  }

  async sendDocumentAuthorizedToCompany(data: CompanyDocumentEmailData, sender?: CompanySender | null): Promise<void> {
    const from = this.fromWithName(data.companyTradeName || data.companyName);

    const docTypeLabels: Record<string, string> = {
      '01': 'Factura',
      '03': 'Liquidación de Compras',
      '04': 'Nota de Crédito',
      '05': 'Nota de Débito',
      '06': 'Guía de Remisión',
      '07': 'Retención',
    };
    const docTypeLabel = docTypeLabels[data.docType] || 'Documento';

    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a2e;margin-bottom:8px">${docTypeLabel} Autorizada — Copia Empresa</h2>
        <p style="color:#555;font-size:14px">
          Se ha autorizado exitosamente la siguiente ${docTypeLabel.toLowerCase()} emitida por <strong>${data.companyName}</strong>.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600;width:45%">Tipo</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${docTypeLabel}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Secuencial</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.sequential}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Cliente</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.buyerName} (${data.buyerId})</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Total</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef;font-weight:600">$${data.totalAmount}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">N° Autorización</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef;font-size:11px;word-break:break-all">${data.authNumber}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f8f9fa;border:1px solid #e9ecef;font-weight:600">Fecha Autorización</td>
            <td style="padding:8px 12px;border:1px solid #e9ecef">${data.authDate}</td>
          </tr>
        </table>
        <p style="color:#555;font-size:13px">
          Adjunto encontrará el RIDE (PDF) y el comprobante electrónico (XML) autorizados.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:11px;text-align:center">
          ${data.companyName} (${data.companyRuc}) — Generado por
          <a href="https://autorizadorec.com" style="color:#aaa;text-decoration:underline">AutorizadorEC</a>
        </p>
      </div>
    `;

    const attachments: nodemailer.SendMailOptions['attachments'] = [];
    if (data.rideBuffer) {
      attachments.push({
        filename: `${data.sequential.replace(/-/g, '')}.pdf`,
        content: data.rideBuffer,
        contentType: 'application/pdf',
      });
    }
    if (data.xmlBuffer) {
      attachments.push({
        filename: `${data.sequential.replace(/-/g, '')}.xml`,
        content: data.xmlBuffer,
        contentType: 'application/xml',
      });
    }

    try {
      const via = await this.deliver({
        from,
        to: data.companyEmail,
        subject: `[Copia] ${docTypeLabel} ${data.sequential} — ${data.buyerName}`,
        html,
        attachments,
      }, sender);

      if (!this.config.get('SMTP_HOST') && via === 'platform') {
        this.logger.log(`[DEV EMAIL] Company copy to: ${data.companyEmail} | ${data.sequential}`);
      } else {
        this.logger.log(`Company copy email sent to ${data.companyEmail} for ${data.sequential} (via ${via} SMTP)`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to send company email to ${data.companyEmail}: ${err.message}`);
    }
  }
}
