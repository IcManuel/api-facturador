import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Company } from './company.entity';
import { Establishment } from './establishment.entity';

@Entity({ schema: 'app', name: 'emission_point' })
export class EmissionPoint {
  @PrimaryGeneratedColumn({ name: 'emp_id' })
  id: number;

  @Column({ name: 'com_id' })
  companyId: number;

  @Column({ name: 'est_id' })
  establishmentId: number;

  @Column({ name: 'emp_code', length: 3 })
  code: string;

  @Column({ name: 'emp_description', length: 200, nullable: true })
  description: string;

  @Column({ name: 'emp_is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'emp_created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Company, (c) => c.emissionPoints, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'com_id' })
  company: Company;

  @ManyToOne(() => Establishment, (e) => e.emissionPoints, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'est_id' })
  establishment: Establishment;
}
