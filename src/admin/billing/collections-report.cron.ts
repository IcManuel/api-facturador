import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';
import { NotificationService } from '../../notifications/notification.service';
import { RedisLockService } from '../../common/services/redis-lock.service';

const DEFAULT_RECIPIENTS = 'salazarmanuel6@gmail.com';

@Injectable()
export class CollectionsReportCron {
  private readonly logger = new Logger(CollectionsReportCron.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly notificationService: NotificationService,
    private readonly redisLock: RedisLockService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Todos los días a las 08:00 (hora del servidor, América/Guayaquil).
   * Envía el reporte de quién debe pagar hoy.
   */
  @Cron('0 8 * * *')
  async handleDailyCollectionsReport(): Promise<void> {
    const acquired = await this.redisLock.acquire('collections-report', 300);
    if (!acquired) {
      this.logger.debug('Collections report skipped — another instance holds the lock');
      return;
    }

    try {
      await this.sendReport();
    } catch (err: any) {
      this.logger.error(`Collections report failed: ${err.message}`, err.stack);
    } finally {
      await this.redisLock.release('collections-report');
    }
  }

  /** Genera y envía el reporte. Reutilizable desde el endpoint manual. */
  async sendReport(now: Date = new Date()) {
    const report = await this.billingService.getCollectionsDueToday(now);
    const recipients = this.config
      .get<string>('COLLECTIONS_REPORT_TO', DEFAULT_RECIPIENTS)
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    await this.notificationService.sendCollectionsReport(recipients, report);
    this.logger.log(
      `Collections report sent to ${recipients.join(', ')} — ${report.accounts.length} account(s), $${report.totalDueToday.toFixed(2)}`,
    );
    return { recipients, ...report };
  }
}
