import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, In } from 'typeorm';
import { Certificate } from '../entities/certificate.entity';
import { BillingPeriod } from '../entities/billing-period.entity';
import { Account } from '../entities/account.entity';
import { BillingStatus, AccountStatus } from '../entities/enums';
import { NotificationService } from './notification.service';
import { RedisLockService } from '../common/services/redis-lock.service';

@Injectable()
export class NotificationCron {
  private readonly logger = new Logger(NotificationCron.name);

  constructor(
    @InjectRepository(Certificate)
    private readonly certRepo: Repository<Certificate>,
    @InjectRepository(BillingPeriod)
    private readonly billingRepo: Repository<BillingPeriod>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly notificationService: NotificationService,
    private readonly redisLock: RedisLockService,
  ) {}

  /**
   * Every day at 10:00 AM (America/Guayaquil = UTC-5 → 15:00 UTC)
   * Checks certificates expiring in <15 days or already expired.
   */
  @Cron('0 15 * * *') // 10:00 AM ECT
  async handleCertificateExpiry(): Promise<void> {
    const acquired = await this.redisLock.acquire('notification-cert-expiry', 300);
    if (!acquired) return;

    try {
      const warningDate = new Date();
      warningDate.setDate(warningDate.getDate() + 15);

      // Find current certificates that expire within 15 days (or are already expired)
      const certs = await this.certRepo.find({
        where: {
          isCurrent: true,
          expiresAt: LessThanOrEqual(warningDate),
        },
        relations: ['company', 'company.account'],
      });

      if (certs.length === 0) return;

      this.logger.log(`Found ${certs.length} certificates expiring soon or expired`);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (const cert of certs) {
        const company = cert.company;
        if (!company || !company.isActive) continue;
        if (company.account?.isInternal) continue; // skip cuentas propias

        const expiresAt = new Date(cert.expiresAt);
        expiresAt.setHours(0, 0, 0, 0);
        const daysLeft = Math.ceil((expiresAt.getTime() - today.getTime()) / 86_400_000);
        const expired = daysLeft <= 0;

        await this.notificationService.sendCertificateExpiry({
          companyName: company.name,
          companyRuc: company.ruc,
          companyEmail: company.email,
          notificationEmail: company.notificationEmail,
          certSubject: cert.subjectCn,
          expiresAt: cert.expiresAt instanceof Date
            ? cert.expiresAt.toISOString().slice(0, 10)
            : String(cert.expiresAt),
          daysLeft: Math.max(0, daysLeft),
          expired,
        });
      }
    } catch (err: any) {
      this.logger.error(`Certificate expiry cron failed: ${err.message}`, err.stack);
    } finally {
      await this.redisLock.release('notification-cert-expiry');
    }
  }

  /** Días de gracia entre el aviso al cliente y el aviso de bloqueo a administración. */
  static readonly GRACE_DAYS = 5;

  /**
   * Todos los días a las 15:00 (hora del servidor, América/Guayaquil).
   *
   * Cobranza estricta:
   *  - Un día después de la fecha de pago: se avisa al cliente que su cuenta
   *    se bloqueará en 5 días.
   *  - Cumplidos esos 5 días sin pago: se avisa a administración con la lista
   *    de cuentas a bloquear. El bloqueo es manual, no automático.
   */
  @Cron('0 15 * * *')
  async handleOverduePayments(): Promise<void> {
    const acquired = await this.redisLock.acquire('notification-overdue', 300);
    if (!acquired) return;

    try {
      const periods = await this.billingRepo.find({
        where: {
          status: In([BillingStatus.PENDING, BillingStatus.PARTIAL, BillingStatus.OVERDUE]),
        },
        relations: ['account', 'account.companies'],
      });

      const today = this.startOfDay(new Date());
      const paraBloquear: Array<{
        accountId: number; accountName: string; accountEmail: string;
        balance: number; daysLate: number;
      }> = [];

      for (const bp of periods) {
        const account = bp.account;
        if (!account || !account.isActive || account.isInternal) continue;
        if (account.status === AccountStatus.BLOCKED) continue;

        const balance = Number(bp.total) - Number(bp.paidAmount ?? 0);
        if (balance <= 0) continue;

        const dueDate = this.dueDateOf(bp);
        const daysLate = Math.round((today.getTime() - dueDate.getTime()) / 86_400_000);
        const blockDate = new Date(dueDate);
        blockDate.setDate(blockDate.getDate() + 1 + NotificationCron.GRACE_DAYS);

        const companyEmails = (account.companies ?? [])
          .filter((c) => c.isActive)
          .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));

        if (daysLate === 1) {
          await this.notificationService.sendBlockWarning({
            accountName: account.name,
            accountEmail: account.email,
            companyEmails,
            year: bp.year,
            month: bp.month,
            balance,
            blockDate: blockDate.toISOString().slice(0, 10),
            graceDays: NotificationCron.GRACE_DAYS,
          });
          this.logger.log(`Aviso de bloqueo enviado a cuenta ${account.id} (${account.name}) — $${balance.toFixed(2)}`);
        } else if (daysLate === 1 + NotificationCron.GRACE_DAYS) {
          paraBloquear.push({
            accountId: account.id,
            accountName: account.name,
            accountEmail: account.email,
            balance,
            daysLate,
          });
        }
      }

      if (paraBloquear.length > 0) {
        await this.notificationService.sendAccountsToBlock(
          this.blockAlertRecipients(),
          paraBloquear,
        );
        this.logger.log(`Aviso a administración: ${paraBloquear.length} cuenta(s) para bloquear`);
      }
    } catch (err: any) {
      this.logger.error(`Overdue payments cron failed: ${err.message}`, err.stack);
    } finally {
      await this.redisLock.release('notification-overdue');
    }
  }

  /** Fecha en la que el período debía pagarse: el día de cierre del ciclo. */
  private dueDateOf(bp: BillingPeriod): Date {
    if (bp.periodEndDate) {
      const d = new Date(`${bp.periodEndDate}T00:00:00`);
      d.setDate(d.getDate() + 1);
      return this.startOfDay(d);
    }
    // Períodos antiguos sin fechas de ciclo: vencen el primer día del mes siguiente.
    return this.startOfDay(new Date(bp.year, bp.month, 1));
  }

  private startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  private blockAlertRecipients(): string[] {
    return (process.env.COLLECTIONS_REPORT_TO || 'salazarmanuel6@gmail.com')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }

  /**
   * Every 6 hours. Auto-block expired trial accounts.
   */
  @Cron('0 */6 * * *')
  async handleExpiredTrials(): Promise<void> {
    const acquired = await this.redisLock.acquire('trial-expiry-check', 120);
    if (!acquired) return;

    try {
      const expired = await this.accountRepo.find({
        where: {
          status: AccountStatus.TRIAL,
          trialEndsAt: LessThanOrEqual(new Date()),
          isInternal: false,
        },
      });

      if (expired.length === 0) return;

      this.logger.log(`Found ${expired.length} expired trial accounts — blocking`);

      for (const account of expired) {
        account.status = AccountStatus.BLOCKED;
        await this.accountRepo.save(account);
        this.logger.log(`Trial expired — blocked account ${account.id} (${account.name})`);
      }
    } catch (err: any) {
      this.logger.error(`Trial expiry cron failed: ${err.message}`, err.stack);
    } finally {
      await this.redisLock.release('trial-expiry-check');
    }
  }
}
