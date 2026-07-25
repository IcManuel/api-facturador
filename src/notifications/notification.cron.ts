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

  /**
   * Every day at 10:00 AM (ECT).
   * Sends reminders for overdue billing periods.
   */
  @Cron('0 15 * * *') // 10:00 AM ECT
  async handleOverduePayments(): Promise<void> {
    const acquired = await this.redisLock.acquire('notification-overdue', 300);
    if (!acquired) return;

    try {
      const overduePeriods = await this.billingRepo.find({
        where: {
          status: In([BillingStatus.PENDING, BillingStatus.PARTIAL, BillingStatus.OVERDUE]),
        },
        relations: ['account', 'account.companies'],
      });

      if (overduePeriods.length === 0) return;

      // Only notify for periods that are past their month
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;

      const pastDue = overduePeriods.filter((bp) => {
        if (bp.year < currentYear) return true;
        if (bp.year === currentYear && bp.month < currentMonth) return true;
        return false;
      });

      if (pastDue.length === 0) return;

      this.logger.log(`Found ${pastDue.length} overdue billing periods`);

      for (const bp of pastDue) {
        const account = bp.account;
        if (!account || !account.isActive) continue;
        if (account.isInternal) continue; // skip cuentas propias

        // Calculate days since the period ended
        const periodEnd = new Date(bp.year, bp.month, 1); // first day of next month
        const daysSinceDue = Math.floor((now.getTime() - periodEnd.getTime()) / 86_400_000);

        const companyEmails = (account.companies ?? [])
          .filter((c) => c.isActive)
          .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));

        await this.notificationService.sendOverduePayment({
          accountName: account.name,
          accountEmail: account.email,
          companyEmails,
          year: bp.year,
          month: bp.month,
          total: Number(bp.total),
          paidAmount: Number(bp.paidAmount),
          daysSinceDue,
        });
      }
    } catch (err: any) {
      this.logger.error(`Overdue payments cron failed: ${err.message}`, err.stack);
    } finally {
      await this.redisLock.release('notification-overdue');
    }
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
