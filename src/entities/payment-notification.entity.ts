import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type NotificationResult =
  | 'RECIBIDA' | 'APLICADA' | 'REPETIDA' | 'RECHAZO' | 'SIN_PAGO' | 'MONTO' | 'IGNORADA' | 'ERROR';

@Entity({ schema: 'app', name: 'payment_notification' })
export class PaymentNotification {
  @PrimaryGeneratedColumn({ name: 'pno_id' })
  id: number;

  @Column({ name: 'pno_hash', type: 'varchar', length: 64, unique: true })
  hash: string;

  @Column({ name: 'pno_source', type: 'varchar', length: 10 })
  source: 'mila' | 'plux';

  @Column({ name: 'pno_tx_id', type: 'varchar', length: 80, nullable: true })
  txId: string | null;

  @Column({ name: 'pno_state', type: 'varchar', length: 20, nullable: true })
  state: string | null;

  @Column({ name: 'pno_amount_cents', type: 'int', nullable: true })
  amountCents: number | null;

  @Column({ name: 'pno_extras', type: 'varchar', length: 300, nullable: true })
  extras: string | null;

  @Column({ name: 'pno_payload', type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ name: 'pno_ip', type: 'varchar', length: 60, nullable: true })
  ip: string | null;

  @Column({ name: 'pno_result', type: 'varchar', length: 20, default: 'RECIBIDA' })
  result: NotificationResult;

  @Column({ name: 'pno_detail', type: 'text', nullable: true })
  detail: string | null;

  @Column({ name: 'pno_attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'pin_id', type: 'int', nullable: true })
  intentId: number | null;

  @CreateDateColumn({ name: 'pno_created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'pno_processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
