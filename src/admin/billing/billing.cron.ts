import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BillingService } from './billing.service';
import { RedisLockService } from '../../common/services/redis-lock.service';

@Injectable()
export class BillingCron {
  private readonly logger = new Logger(BillingCron.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly redisLock: RedisLockService,
  ) {}

  /**
   * Daily at 08:00 UTC (03:00 ECT). Closes anniversary billing periods for
   * every active account whose billingCycleDay is today.
   * Idempotent — safe to run multiple times.
   */
  @Cron('0 8 * * *')
  async closeAnniversaryPeriodsToday(): Promise<void> {
    const acquired = await this.redisLock.acquire('billing-anniversary-close', 900);
    if (!acquired) {
      this.logger.debug('Anniversary billing cron skipped — another instance holds the lock');
      return;
    }
    try {
      const result = await this.billingService.closeAnniversaryPeriodsForToday();
      if (result.matched > 0) {
        this.logger.log(
          `Anniversary billing close: matched=${result.matched} created=${result.created} skipped=${result.skipped}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Anniversary billing cron failed: ${err.message}`, err.stack);
    } finally {
      await this.redisLock.release('billing-anniversary-close');
    }
  }
}
