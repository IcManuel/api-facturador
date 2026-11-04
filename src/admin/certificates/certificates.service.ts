import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as forge from 'node-forge';
import { Certificate } from '../../entities/certificate.entity';
import { CryptoService } from '../../common/services/crypto.service';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { ymdEc } from '../../common/utils/date.util';

export interface P12ValidationResult {
  subjectCn: string;
  issuerCn: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  isExpired: boolean;
  daysUntilExpiry: number;
}

@Injectable()
export class CertificatesService {
  constructor(
    @InjectRepository(Certificate)
    private readonly repo: Repository<Certificate>,
    private readonly crypto: CryptoService,
    private readonly dataSource: DataSource,
  ) {}

  async findAll(
    page = 1,
    limit = 20,
    companyId?: number,
    expiringSoon?: boolean,
  ): Promise<PaginatedResult<Certificate>> {
    const qb = this.repo.createQueryBuilder('cer');
    qb.leftJoinAndSelect('cer.company', 'company');

    if (companyId) {
      qb.andWhere('cer.companyId = :companyId', { companyId });
    }
    if (expiringSoon) {
      qb.andWhere("cer.expiresAt <= NOW() + INTERVAL '30 days'");
    }

    qb.orderBy('cer.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: number): Promise<Certificate> {
    const cert = await this.repo.findOne({
      where: { id },
      relations: ['company'],
    });
    if (!cert) throw new NotFoundException('Certificado no encontrado');
    return cert;
  }

  validateP12(fileBuffer: Buffer, password: string): P12ValidationResult {
    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
      const asn1 = forge.asn1.fromDer(fileBuffer.toString('binary'));
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
    } catch {
      throw new BadRequestException(
        'No se pudo abrir el archivo .p12. Verifique que el archivo sea valido y la contrasena sea correcta.',
      );
    }

    // Extract certificate bags
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certs = certBags[forge.pki.oids.certBag];

    if (!certs || certs.length === 0) {
      throw new BadRequestException(
        'El archivo .p12 no contiene certificados.',
      );
    }

    // Find the end-entity certificate (not a CA cert)
    const userCert = certs.find((bag) => {
      const cert = bag.cert;
      if (!cert) return false;
      const bc = cert.getExtension('basicConstraints') as any;
      return !bc || !bc.cA;
    });

    const cert = userCert?.cert ?? certs[0].cert;
    if (!cert) {
      throw new BadRequestException(
        'No se encontro un certificado de usuario en el archivo .p12.',
      );
    }

    // Also verify a private key exists
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keys = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
    if (!keys || keys.length === 0) {
      throw new BadRequestException(
        'El archivo .p12 no contiene una clave privada. Se requiere para la firma electronica.',
      );
    }

    const subjectCn =
      cert.subject.getField('CN')?.value ?? cert.subject.getField('O')?.value ?? 'Desconocido';
    const issuerCn =
      cert.issuer.getField('CN')?.value ?? cert.issuer.getField('O')?.value ?? 'Desconocido';
    const serialNumber = cert.serialNumber;

    const validFrom = cert.validity.notBefore;
    const validTo = cert.validity.notAfter;
    const now = new Date();
    const isExpired = validTo < now;
    const daysUntilExpiry = Math.ceil(
      (validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (isExpired) {
      throw new BadRequestException(
        `El certificado esta caducado desde el ${ymdEc(validTo)}. Suba un certificado vigente.`,
      );
    }

    return {
      subjectCn,
      issuerCn,
      serialNumber,
      validFrom,
      validTo,
      isExpired,
      daysUntilExpiry,
    };
  }

  async upload(
    companyId: number,
    fileBuffer: Buffer,
    fileName: string,
    password: string,
    uploadedBy: number | null,
  ): Promise<{ certificate: Certificate; validation: P12ValidationResult }> {
    // 1. Validate the .p12 file
    const validation = this.validateP12(fileBuffer, password);

    // 2. Encrypt the .p12 file content
    const { encrypted: p12Encrypted, iv: p12Iv } =
      this.crypto.encrypt(fileBuffer);

    // 3. Encrypt the password
    const { encrypted: passwordEncrypted, iv: passwordIv } =
      this.crypto.encryptString(password);
    // Store both encrypted password and its IV together as "enc:iv"
    const passwordEnc = `${passwordEncrypted}:${passwordIv}`;

    // 4. Save in a transaction (mark previous current as not current)
    return this.dataSource.transaction(async (manager) => {
      // Unset current for this company
      await manager
        .createQueryBuilder()
        .update(Certificate)
        .set({ isCurrent: false })
        .where('companyId = :companyId AND isCurrent = true', { companyId })
        .execute();

      // Create new certificate
      const cert = manager.create(Certificate, {
        companyId,
        fileName,
        s3Key: null,
        passwordEnc,
        expiresAt: validation.validTo,
        isCurrent: true,
        uploadedBy,
        p12Encrypted,
        p12Iv,
        subjectCn: validation.subjectCn,
      });

      const saved = await manager.save(Certificate, cert);

      return { certificate: saved, validation };
    });
  }

  async getDecryptedP12(
    certificateId: number,
  ): Promise<{ buffer: Buffer; password: string }> {
    const cert = await this.repo
      .createQueryBuilder('c')
      .addSelect('c.p12Encrypted')
      .addSelect('c.p12Iv')
      .addSelect('c.passwordEnc')
      .where('c.id = :id', { id: certificateId })
      .getOne();

    if (!cert) throw new NotFoundException('Certificado no encontrado');
    if (!cert.p12Encrypted || !cert.p12Iv) {
      throw new BadRequestException(
        'Este certificado no tiene archivo .p12 almacenado.',
      );
    }

    const buffer = this.crypto.decrypt(cert.p12Encrypted, cert.p12Iv);

    const [encPwd, ivPwd] = cert.passwordEnc.split(':');
    const password = this.crypto.decryptString(encPwd, ivPwd);

    return { buffer, password };
  }
}
