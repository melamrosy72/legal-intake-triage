import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { describeError } from '../common/safe-exception.filter.js';
import { ENV, type Env } from '../config/env.js';

export const TRIAGE_QUEUE_NAME = 'triage';
/** Custom backoff type; the worker maps it to computeBackoffMs. */
export const TRIAGE_BACKOFF_TYPE = 'triage';

/**
 * Upper bound on one enqueue. Until the first connection succeeds, BullMQ waits for Redis
 * instead of failing, so an app started while Redis is down would hang every POST. A
 * timed-out add can still go through once Redis is back: harmless, since jobId dedupes it.
 */
const ENQUEUE_TIMEOUT_MS = 1_500;

class EnqueueTimeoutError extends Error {
  override name = 'EnqueueTimeoutError';
}

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
        // enqueue() runs inside POST /inquiries. Once connected, a lost connection fails the add
        // at once instead of ioredis holding it in its offline queue across reconnects (minutes).
        // The client gets 503 and its replay re-enqueues (InquiriesService.replay).
        enableOfflineQueue: false,
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
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EnqueueTimeoutError()),
        ENQUEUE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        this.queue.add('triage', { inquiryId }, { jobId: inquiryId }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
