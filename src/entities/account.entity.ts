import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { AccountType, AccountStatus } from './enums';
import { AccountUser } from './account-user.entity';
import { Company } from './company.entity';
import { BillingPeriod } from './billing-period.entity';

@Entity({ schema: 'app', name: 'account' })
export class Account {
  @PrimaryGeneratedColumn({ name: 'acc_id' })
  id: number;

  @Column({ name: 'acc_name', length: 200 })
  name: string;

  @Column({ name: 'acc_ruc', length: 13, unique: true })
  ruc: string;

  @Column({ name: 'acc_email', length: 254 })
  email: string;

  @Column({ name: 'acc_phone', length: 30, nullable: true })
  phone: string;

  @Column({ name: 'acc_address', type: 'text', nullable: true })
  address: string;

  @Column({ name: 'acc_type', type: 'enum', enum: AccountType, enumName: 'account_type', default: AccountType.SINGLE })
  type: AccountType;

  @Column({ name: 'acc_status', type: 'enum', enum: AccountStatus, enumName: 'account_status', default: AccountStatus.ACTIVE })
  status: AccountStatus;

  @Column({ name: 'acc_trial_ends_at', type: 'timestamptz', nullable: true })
  trialEndsAt: Date | null;

  @Column({ name: 'acc_billing_cycle_day', type: 'smallint', default: 1 })
  billingCycleDay: number;

  @Column({ name: 'acc_warning_message', type: 'text', nullable: true })
  warningMessage: string | null;

  @Column({ name: 'acc_ride_footer', type: 'text', nullable: true })
  rideFooter: string | null;

  @Column({ name: 'acc_is_internal', type: 'boolean', default: false })
  isInternal: boolean;

  @Column({ name: 'acc_api_key', type: 'varchar', length: 100, unique: true, nullable: true })
  apiKey: string | null;

  @Column({ name: 'acc_is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'acc_created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'acc_updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date;

  @OneToMany(() => AccountUser, (u) => u.account)
  users: AccountUser[];

  @OneToMany(() => Company, (c) => c.account)
  companies: Company[];

  @OneToMany(() => BillingPeriod, (b) => b.account)
  billingPeriods: BillingPeriod[];
}
