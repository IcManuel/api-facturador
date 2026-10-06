import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SmtpService } from './smtp.service';
import { MailService } from '../../common/services/mail.service';

describe('SmtpService.assertCompanyOfAccount', () => {
  const companyRepo = { count: jest.fn() };
  const service = new SmtpService({} as any, companyRepo as any, {} as any);

  beforeEach(() => companyRepo.count.mockReset());

  it('acepta una empresa de la cuenta', async () => {
    companyRepo.count.mockResolvedValue(1);
    await expect(service.assertCompanyOfAccount(63, 101)).resolves.toBeUndefined();
    expect(companyRepo.count).toHaveBeenCalledWith({ where: { id: 101, accountId: 63 } });
  });

  it('rechaza una empresa de otra cuenta', async () => {
    companyRepo.count.mockResolvedValue(0);
    await expect(service.assertCompanyOfAccount(63, 12)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exige el companyId', async () => {
    await expect(service.assertCompanyOfAccount(63, undefined as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(companyRepo.count).not.toHaveBeenCalled();
  });
});

describe('SmtpService.getSender', () => {
  it('usa el remitente configurado por la empresa', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue({
        companyId: 101, host: 'vps.example.com', port: 465, secure: 'ssl', user: 'u',
        password: 'x', passwordIv: 'y', fromEmail: 'no-reply@qvet.ec', fromName: 'QVET "Vet"', isActive: true,
      }),
    };
    const crypto = { decryptString: jest.fn().mockReturnValue('secret') };
    const service = new SmtpService(repo as any, {} as any, crypto as any);

    const sender = await service.getSender(101);

    expect(repo.findOne).toHaveBeenCalledWith({ where: { companyId: 101, isActive: true } });
    expect(sender?.from).toBe('"QVET Vet" <no-reply@qvet.ec>');
  });

  it('devuelve null si la empresa no tiene SMTP activo', async () => {
    const service = new SmtpService({ findOne: jest.fn().mockResolvedValue(null) } as any, {} as any, {} as any);
    await expect(service.getSender(101)).resolves.toBeNull();
  });
});

describe('MailService envío con SMTP de la empresa', () => {
  const config = { get: (key: string, def?: any) => (key === 'SMTP_HOST' ? 'smtp.platform' : def) };
  const data = {
    buyerName: 'Juan', buyerEmail: 'juan@example.com', companyName: 'QVET', companyRuc: '0999999999001',
    docType: '01', sequential: '001-001-000000001', authNumber: '1', authDate: 'hoy', totalAmount: '10.00',
  };

  function build() {
    const mail = new MailService(config as any);
    const platform = { sendMail: jest.fn().mockResolvedValue({}) };
    (mail as any).transporter = platform;
    return { mail, platform };
  }

  it('sale por el SMTP de la empresa con su remitente', async () => {
    const { mail, platform } = build();
    const company = { sendMail: jest.fn().mockResolvedValue({}) };

    await mail.sendDocumentAuthorized(data, { transporter: company as any, from: 'QVET <no-reply@qvet.ec>' });

    expect(company.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'QVET <no-reply@qvet.ec>', to: 'juan@example.com' }));
    expect(platform.sendMail).not.toHaveBeenCalled();
  });

  it('si el SMTP de la empresa falla, sale por el de la plataforma', async () => {
    const { mail, platform } = build();
    const company = { sendMail: jest.fn().mockRejectedValue(new Error('auth failed')) };

    await mail.sendDocumentAuthorized(data, { transporter: company as any, from: 'QVET <no-reply@qvet.ec>' });

    expect(platform.sendMail).toHaveBeenCalledTimes(1);
    expect(platform.sendMail.mock.calls[0][0].to).toBe('juan@example.com');
  });

  it('sin SMTP propio usa el de la plataforma', async () => {
    const { mail, platform } = build();
    await mail.sendDocumentAuthorizedToCompany({ ...data, companyEmail: 'a@b.com', buyerId: '1' }, null);
    expect(platform.sendMail).toHaveBeenCalledTimes(1);
  });
});
