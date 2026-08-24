import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import axios from 'axios';
import { Document } from '../entities/document.entity';
import { SriService } from '../engine/sri/sri.service';
import { SRI_URLS } from '../engine/sri/sri.constants';
import { DOCUMENT_QUEUE } from '../queues/queues.constants';

type ComponentStatus = 'operational' | 'degraded' | 'down';

const PING_TIMEOUT_MS = 5000;

@Injectable()
export class StatusService {
  constructor(
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectQueue(DOCUMENT_QUEUE)
    private readonly documentQueue: Queue,
    private readonly sriService: SriService,
  ) {}

  async getStatus() {
    const [database, queue, sriProduction, sriTest, activity] = await Promise.all([
      this.checkDatabase(),
      this.checkQueue(),
      this.checkSri('production'),
      this.checkSri('test'),
      this.getRecentActivity(),
    ]);

    const circuit = this.sriService.getCircuitStatus();

    const components = {
      api: { status: 'operational' as ComponentStatus },
      database,
      queue,
      sri: {
        production: { ...sriProduction, circuitState: circuit.production?.state ?? 'closed' },
        test: { ...sriTest, circuitState: circuit.test?.state ?? 'closed' },
      },
    };

    const overall = this.overallStatus([
      components.api.status,
      components.database.status,
      components.queue.status,
      components.sri.production.status,
      components.sri.test.status,
    ]);

    return {
      status: overall,
      timestamp: new Date().toISOString(),
      components,
      activity,
    };
  }

  private overallStatus(statuses: ComponentStatus[]): ComponentStatus {
    if (statuses.includes('down')) return 'down';
    if (statuses.includes('degraded')) return 'degraded';
    return 'operational';
  }

  private async checkDatabase(): Promise<{ status: ComponentStatus; latencyMs: number | null }> {
    const start = Date.now();
    try {
      await this.docRepo.query('SELECT 1');
      return { status: 'operational', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: null };
    }
  }

  private async checkQueue(): Promise<{ status: ComponentStatus; latencyMs: number | null }> {
    const start = Date.now();
    try {
      await this.documentQueue.getJobCounts();
      return { status: 'operational', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: null };
    }
  }

  private async checkSri(env: 'production' | 'test'): Promise<{ status: ComponentStatus; latencyMs: number | null }> {
    const start = Date.now();
    try {
      await axios.get(SRI_URLS[env].reception, { timeout: PING_TIMEOUT_MS, validateStatus: () => true });
      return { status: 'operational', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: null };
    }
  }

  private async getRecentActivity() {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [total, authorized] = await Promise.all([
      this.docRepo.createQueryBuilder('d')
        .where('d.env = :env', { env: 'production' })
        .andWhere('d.createdAt >= :since', { since })
        .getCount(),
      this.docRepo.createQueryBuilder('d')
        .where('d.env = :env', { env: 'production' })
        .andWhere('d.status = :status', { status: 'AUTHORIZED' })
        .andWhere('d.createdAt >= :since', { since })
        .getCount(),
    ]);

    return {
      documentsLast24h: total,
      authorizedLast24h: authorized,
    };
  }
}
