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
import { CompanyEnv, CompanyStatus, AccessKeyMode, SequentialMode } from './enums';
import { Account } from './account.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { EmissionPoint } from './emission-point.entity';
import { CompanyDocType } from './company-doc-type.entity';
import { Certificate } from './certificate.entity';
import { Document } from './document.entity';

@Entity({ schema: 'app', name: 'company' })
export class Company {
  @PrimaryGeneratedColumn({ name: 'com_id' })
  id: number;

  @Column({ name: 'acc_id' })
  accountId: number;

  @Column({ name: 'spl_id' })
  planId: number;

  @Column({ name: 'com_name', length: 300 })
  name: string;

  @Column({ name: 'com_trade_name', length: 300, nullable: true })
  tradeName: string;

  @Column({ name: 'com_ruc', length: 13, unique: true })
  ruc: string;

  @Column({ name: 'com_address', type: 'text', nullable: true })
  address: string;

  @Column({ name: 'com_email', length: 254, nullable: true })
  email: string;

  @Column({ name: 'com_phone', length: 30, nullable: true })
  phone: string;

  @Column({ name: 'com_env', type: 'enum', enum: CompanyEnv, enumName: 'company_env', default: CompanyEnv.TEST })
  env: CompanyEnv;

  @Column({ name: 'com_status', type: 'enum', enum: CompanyStatus, enumName: 'company_status', default: CompanyStatus.ACTIVE })
  status: CompanyStatus;

  @Column({ name: 'com_establishment', length: 3, default: '001' })
  establishment: string;

  @Column({ name: 'com_api_key', length: 100, unique: true })
  apiKey: string;

  @Column({ name: 'com_webhook_url', type: 'text', nullable: true })
  webhookUrl: string;

  @Column({ name: 'com_webhook_secret', length: 100, nullable: true })
  webhookSecret: string;

  @Column({ name: 'com_access_key_mode', type: 'enum', enum: AccessKeyMode, enumName: 'access_key_mode', default: AccessKeyMode.PLATFORM })
  accessKeyMode: AccessKeyMode;

  @Column({ name: 'com_sequential_mode', type: 'enum', enum: SequentialMode, enumName: 'sequential_mode', default: SequentialMode.PLATFORM })
  sequentialMode: SequentialMode;

  @Column({ name: 'com_overage_enabled', default: false })
  overageEnabled: boolean;

  @Column({ name: 'com_notify_client', default: true })
  notifyClient: boolean;

  @Column({ name: 'com_notify_company', default: true })
  notifyCompany: boolean;

  @Column({ name: 'com_notification_email', type: 'varchar', length: 254, nullable: true })
  notificationEmail: string | null;

  @Column({ name: 'com_logo_s3_key', length: 500, nullable: true })
  logoS3Key: string;

  @Column({ name: 'com_timezone', type: 'text', default: 'America/Guayaquil' })
  timezone: string;

  @Column({ name: 'com_billing_start_date', type: 'date', nullable: true })
  billingStartDate: string | null;

  @Column({ name: 'com_is_active', default: true })
  isActive: boolean;

  @Column({ name: 'com_test_doc_limit', type: 'smallint', nullable: true })
  testDocLimit: number | null;

  @CreateDateColumn({ name: 'com_created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'com_updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date;

  @ManyToOne(() => Account, (a) => a.companies, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'acc_id' })
  account: Account;

  @ManyToOne(() => SubscriptionPlan, (p) => p.companies, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'spl_id' })
  plan: SubscriptionPlan;

  @OneToMany(() => EmissionPoint, (e) => e.company)
  emissionPoints: EmissionPoint[];

  @OneToMany(() => CompanyDocType, (d) => d.company)
  docTypes: CompanyDocType[];

  @OneToMany(() => Certificate, (c) => c.company)
  certificates: Certificate[];

  @OneToMany(() => Document, (d) => d.company)
  documents: Document[];
}
