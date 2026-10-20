import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { PaymentMethod } from './enums';
import { BillingPeriod } from './billing-period.entity';
import { Account } from './account.entity';

@Entity({ schema: 'app', name: 'payment' })
export class Payment {
  @PrimaryGeneratedColumn({ name: 'pay_id' })
  id: number;

  @Column({ name: 'bpe_id' })
  billingPeriodId: number;

  @Column({ name: 'acc_id' })
  accountId: number;

  @Column({ name: 'pay_amount', type: 'numeric', precision: 10, scale: 2 })
  amount: number;

  @Column({ name: 'pay_method', type: 'enum', enum: PaymentMethod, enumName: 'payment_method', default: PaymentMethod.TRANSFER })
  method: PaymentMethod;

  @Column({ name: 'pay_reference', type: 'varchar', length: 200, nullable: true })
  reference: string | null;

  @Column({ name: 'pay_notes', type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'pay_date', type: 'date' })
  date: string;

  /** Intento de PagoPlux que originó el pago (null en pagos registrados a mano). */
  @Column({ name: 'pin_id', type: 'int', nullable: true })
  intentId: number | null;

  @Column({ name: 'pay_recorded_by', length: 150 })
  recordedBy: string;

  @CreateDateColumn({ name: 'pay_created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => BillingPeriod, (bp) => bp.payments, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'bpe_id' })
  billingPeriod: BillingPeriod;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'acc_id' })
  account: Account;
}
