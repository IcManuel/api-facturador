import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { BillingStatus } from './enums';
import { Account } from './account.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { Payment } from './payment.entity';

@Entity({ schema: 'app', name: 'billing_period' })
export class BillingPeriod {
  @PrimaryGeneratedColumn({ name: 'bpe_id' })
  id: number;

  @Column({ name: 'acc_id' })
  accountId: number;

  @Column({ name: 'spl_id' })
  planId: number;

  @Column({ name: 'bpe_year', type: 'smallint' })
  year: number;

  @Column({ name: 'bpe_month', type: 'smallint' })
  month: number;

  @Column({ name: 'bpe_period_start_date', type: 'date', nullable: true })
  periodStartDate: string | null;

  @Column({ name: 'bpe_period_end_date', type: 'date', nullable: true })
  periodEndDate: string | null;

  @Column({ name: 'bpe_docs_total', type: 'int', default: 0 })
  docsTotal: number;

  @Column({ name: 'bpe_docs_authorized', type: 'int', default: 0 })
  docsAuthorized: number;

  @Column({ name: 'bpe_doc_limit', type: 'int', nullable: true })
  docLimit: number | null;

  @Column({ name: 'bpe_base_price', type: 'numeric', precision: 10, scale: 2, default: 0 })
  basePrice: number;

  @Column({ name: 'bpe_overage_docs', type: 'int', default: 0 })
  overageDocs: number;

  @Column({ name: 'bpe_overage_price', type: 'numeric', precision: 8, scale: 4, default: 0 })
  overagePrice: number;

  @Column({ name: 'bpe_overage_total', type: 'numeric', precision: 10, scale: 2, default: 0 })
  overageTotal: number;

  @Column({ name: 'bpe_total', type: 'numeric', precision: 10, scale: 2, default: 0 })
  total: number;

  @Column({ name: 'bpe_status', type: 'enum', enum: BillingStatus, enumName: 'billing_status', default: BillingStatus.PENDING })
  status: BillingStatus;

  @Column({ name: 'bpe_paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn({ name: 'bpe_created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'bpe_updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date;

  @ManyToOne(() => Account, (a) => a.billingPeriods, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'acc_id' })
  account: Account;

  @Column({ name: 'bpe_paid_amount', type: 'numeric', precision: 10, scale: 2, default: 0 })
  paidAmount: number;

  @ManyToOne(() => SubscriptionPlan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'spl_id' })
  plan: SubscriptionPlan;

  @OneToMany(() => Payment, (p) => p.billingPeriod)
  payments: Payment[];
}
