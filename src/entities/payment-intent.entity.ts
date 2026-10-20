import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Account } from './account.entity';

export const INTENT_KIND = { PERIODOS: 'PERIODOS', ACTIVACION: 'ACTIVACION' } as const;
export type IntentKind = (typeof INTENT_KIND)[keyof typeof INTENT_KIND];

export const INTENT_STATUS = {
  /** Creado: el modal de PagoPlux puede estar abierto. */
  PENDIENTE: 'PENDIENTE',
  /** El navegador dice que Plux aprobó; falta la confirmación de Plux (hook). */
  REPORTADO: 'REPORTADO',
  PAGADO: 'PAGADO',
  RECHAZADO: 'RECHAZADO',
  /** Nadie lo completó a tiempo. Si después llega el aviso de un cobro, igual se aplica. */
  EXPIRADO: 'EXPIRADO',
  /** Plux cobró algo que no coincide con lo pedido: revisión manual, no se aplica. */
  ERROR: 'ERROR',
} as const;
export type IntentStatus = (typeof INTENT_STATUS)[keyof typeof INTENT_STATUS];

/** Estados desde los que un aviso de cobro aprobado todavía puede aplicar el pago. */
export const INTENT_APPLICABLE: readonly string[] = [
  INTENT_STATUS.PENDIENTE,
  INTENT_STATUS.REPORTADO,
  INTENT_STATUS.RECHAZADO,
  INTENT_STATUS.EXPIRADO,
];

@Entity({ schema: 'app', name: 'payment_intent' })
export class PaymentIntent {
  @PrimaryGeneratedColumn({ name: 'pin_id' })
  id: number;

  @Column({ name: 'acc_id' })
  accountId: number;

  @Column({ name: 'aus_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'pin_kind', type: 'varchar', length: 20 })
  kind: IntentKind;

  @Column({ name: 'pin_period_ids', type: 'int', array: true, default: () => "'{}'" })
  periodIds: number[];

  @Column({ name: 'pin_plan_id', type: 'int', nullable: true })
  planId: number | null;

  @Column({ name: 'pin_amount_cents', type: 'int' })
  amountCents: number;

  @Column({ name: 'pin_status', type: 'varchar', length: 20, default: INTENT_STATUS.PENDIENTE })
  status: IntentStatus;

  @Column({ name: 'pin_client_tx_id', type: 'varchar', length: 50, unique: true })
  clientTxId: string;

  @Column({ name: 'pin_payer_email', type: 'varchar', length: 254, nullable: true })
  payerEmail: string | null;

  @Column({ name: 'pin_payer_ident_hash', type: 'varchar', length: 64, nullable: true })
  payerIdentHash: string | null;

  @Column({ name: 'pin_provider_tx_id', type: 'varchar', length: 80, nullable: true, unique: true })
  providerTxId: string | null;

  @Column({ name: 'pin_voucher', type: 'varchar', length: 40, nullable: true })
  voucher: string | null;

  @Column({ name: 'pin_card_brand', type: 'varchar', length: 80, nullable: true })
  cardBrand: string | null;

  @Column({ name: 'pin_card_last4', type: 'varchar', length: 4, nullable: true })
  cardLast4: string | null;

  @Column({ name: 'pin_message', type: 'text', nullable: true })
  message: string | null;

  @Column({ name: 'pin_reported_at', type: 'timestamptz', nullable: true })
  reportedAt: Date | null;

  @Column({ name: 'pin_paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'pin_alerted_at', type: 'timestamptz', nullable: true })
  alertedAt: Date | null;

  @CreateDateColumn({ name: 'pin_created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'pin_updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'acc_id' })
  account: Account;
}
