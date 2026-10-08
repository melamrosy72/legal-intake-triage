import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env.js';

export const TRIAGE_QUEUE_NAME = 'triage';
/** Custom backoff type; the worker maps it to computeBackoffMs. */
export const TRIAGE_BACKOFF_TYPE = 'triage';

/** Job payload: the id only. Inquiry text never goes into Redis. */
export interface TriageJobData {
  inquiryId: string;
}

@Injectable()
export class TriageQueue implements OnModuleDestroy {
  readonly queue: Queue<TriageJobData>;

  constructor(@Inject(ENV) env: Env) {
    this.queue = new Queue<TriageJobData>(TRIAGE_QUEUE_NAME, {
      connection: { url: env.REDIS_URL },
      defaultJobOptions: {
        attempts: env.QUEUE_ATTEMPTS,
        backoff: { type: TRIAGE_BACKOFF_TYPE },
        // Keep recent history for debugging without letting Redis grow forever.
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }

  /** jobId = inquiry id, so enqueueing the same inquiry twice is ignored by BullMQ. */
  async enqueue(inquiryId: string): Promise<void> {
    await this.queue.add('triage', { inquiryId }, { jobId: inquiryId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
