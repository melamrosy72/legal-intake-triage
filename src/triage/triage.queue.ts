import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { describeError } from '../common/safe-exception.filter.js';
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
  private readonly logger = new Logger(TriageQueue.name);

  constructor(@Inject(ENV) env: Env) {
    this.queue = new Queue<TriageJobData>(TRIAGE_QUEUE_NAME, {
      connection: {
        url: env.REDIS_URL,
        // enqueue() runs inside POST /inquiries. With Redis down, ioredis would hold the command in
        // its offline queue across reconnects (minutes); fail at once instead, and bound a command
        // on a connection that is up but not answering. The client replays and the replay
        // re-enqueues (InquiriesService.replay).
        enableOfflineQueue: false,
        commandTimeout: 5_000,
      },
      defaultJobOptions: {
        attempts: env.QUEUE_ATTEMPTS,
        backoff: { type: TRIAGE_BACKOFF_TYPE },
        // Keep recent history for debugging without letting Redis grow forever.
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    // Without a listener BullMQ prints the raw error with console.error; log class and code only.
    this.queue.on('error', (err) => {
      const { errorClass, code } = describeError(err);
      this.logger.error(
        `queue error ${errorClass}${code ? ` code=${code}` : ''}`,
      );
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
