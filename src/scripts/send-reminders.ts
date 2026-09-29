/**
 * Envía recordatorios de pago desde la línea de comandos.
 *
 *   node dist/scripts/send-reminders.js 10 33 29 42   → solo esas cuentas
 *   node dist/scripts/send-reminders.js               → todas las que tengan saldo
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BillingService } from '../admin/billing/billing.service';

async function main() {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'error', 'warn'] });

  try {
    const billing = app.get(BillingService);
    const result = await billing.sendPaymentReminders(ids.length ? ids : undefined);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }

  // El contexto deja vivos los workers de colas; salimos explícitamente.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
