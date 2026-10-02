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
import { Company } from './company.entity';
import { EmissionPoint } from './emission-point.entity';

@Entity({ schema: 'app', name: 'establishment' })
export class Establishment {
  @PrimaryGeneratedColumn({ name: 'est_id' })
  id: number;

  @Column({ name: 'com_id' })
  companyId: number;

  @Column({ name: 'est_code', length: 3 })
  code: string;

  @Column({ name: 'est_name', type: 'varchar', length: 200, nullable: true })
  name: string | null;

  @Column({ name: 'est_address', type: 'varchar', length: 300, nullable: true })
  address: string | null;

  @Column({ name: 'est_is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'est_created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'est_updated_at', type: 'timestamptz', nullable: true })
  updatedAt: Date | null;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'com_id' })
  company: Company;

  @OneToMany(() => EmissionPoint, (ep) => ep.establishment)
  emissionPoints: EmissionPoint[];
}
