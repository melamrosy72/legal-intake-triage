import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { describeError } from '../common/safe-exception.filter.js';
import { ENV, type Env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import type { InquiryStatus } from '../generated/prisma/enums.js';
import { LlmTransportError } from '../llm/llm.errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeBackoffMs } from './backoff.js';
import { TRIAGE_QUEUE_NAME, type TriageJobData } from './triage.queue.js';
import { TriageService, type TriageDecision } from './triage.service.js';

const OPEN_STATUSES: InquiryStatus[] = ['RECEIVED', 'PROCESSING'];

/**
 * Thrown instead of any non-transport error. BullMQ stores `err.message` and the stack in Redis,
 * and a raw message (e.g. from Prisma) could contain inquiry text. Class and code only.
 */
export class TriageJobError extends Error {
  constructor({ errorClass, code }: ReturnType<typeof describeError>) {
    super(`${errorClass}${code ? ` code=${code}` : ''}`);
    this.name = 'TriageJobError';
  }
}

/**
 * Owns the retry and terminal-failure policy (§10.4) and worker idempotency (§10.5).
 * Runs in the API process (a demo trade-off; see README).
 */
@Injectable()
export class TriageProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriageProcessor.name);
  private worker?: Worker<TriageJobData>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly triage: TriageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<TriageJobData>(
      TRIAGE_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: { url: this.env.REDIS_URL },
        concurrency: this.env.WORKER_CONCURRENCY,
        // Caps jobs started per window to stay under the provider's per-minute request limit.
        limiter: {
          max: this.env.WORKER_RATE_LIMIT_MAX,
          duration: this.env.WORKER_RATE_LIMIT_DURATION_MS,
        },
        settings: {
          backoffStrategy: (attempt: number, _type?: string, err?: Error) =>
            computeBackoffMs(attempt, err),
        },
      },
    );
    // A Worker emits 'error' for connection problems; with no listener Node would throw.
    this.worker.on('error', (err) => {
      const { errorClass, code } = describeError(err);
      this.logger.error(
        `worker error ${errorClass}${code ? ` code=${code}` : ''}`,
      );
    });
    this.worker.on('failed', (job) => void this.onJobFailed(job));
  }

  /**
   * Safety net for jobs BullMQ gives up on without our process() deciding the outcome: a job
   * that stalled more than maxStalledCount times is failed by BullMQ itself (UnrecoverableError,
   * our code never runs), and a final write that threw on the last attempt also lands here.
   * BullMQ emits 'failed' after EVERY failed attempt; `finishedOn` is only set once it stops retrying.
   */
  async onJobFailed(job: Job<TriageJobData> | undefined): Promise<void> {
    if (!job?.finishedOn) return; // will be retried, or no job to act on
    const { inquiryId } = job.data;
    try {
      const written = await this.finish(inquiryId, {
        status: 'NEEDS_HUMAN_REVIEW',
        reviewReason: 'INTERNAL_ERROR',
        result: null,
      });
      if (written) {
        this.logger.warn(
          `inquiry=${inquiryId} job failed permanently, NEEDS_HUMAN_REVIEW(INTERNAL_ERROR)`,
        );
      }
    } catch (err) {
      const { errorClass, code } = describeError(err);
      this.logger.error(
        `inquiry=${inquiryId} could not record permanent job failure ${errorClass}${code ? ` code=${code}` : ''}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  /** Public so tests can drive one attempt without Redis timing. */
  async process(job: Job<TriageJobData>): Promise<void> {
    try {
      await this.handle(job);
    } catch (err) {
      // LlmTransportError's message is just its kind, and it carries retryAfterMs for the backoff.
      if (err instanceof LlmTransportError) throw err;
      throw new TriageJobError(describeError(err));
    }
  }

  private async handle(job: Job<TriageJobData>): Promise<void> {
    const { inquiryId } = job.data;
    // attemptsMade counts previous failed attempts, so this attempt is attemptsMade + 1.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = attempt >= maxAttempts;
    const started = performance.now();
    const tag = `inquiry=${inquiryId} attempt=${attempt}/${maxAttempts}`;

    let decision: TriageDecision;
    try {
      const inquiry = await this.prisma.inquiry.findUnique({
        where: { id: inquiryId },
        select: { status: true, rawText: true },
      });
      if (!inquiry) {
        this.logger.warn(`${tag} not found, skipping`);
        return;
      }
      // At-least-once delivery: a duplicate or late job must not call the model again.
      if (!OPEN_STATUSES.includes(inquiry.status)) {
        this.logger.log(`${tag} already ${inquiry.status}, skipping`);
        return;
      }
      await this.prisma.inquiry.updateMany({
        where: { id: inquiryId, status: { in: OPEN_STATUSES } },
        data: { status: 'PROCESSING' },
      });
      decision = await this.triage.run(inquiry.rawText, async (call) => {
        await this.prisma.llmCall.create({
          data: { ...call, inquiryId, jobAttempt: attempt },
        });
      });
    } catch (err) {
      const isTransport = err instanceof LlmTransportError;
      const retryable = isTransport ? err.retryable : true;
      const { errorClass, code } = describeError(err);
      const willRetry = retryable && !isLastAttempt;
      this.logger.warn(
        `${tag} failed ${errorClass}${code ? ` code=${code}` : ''}${isTransport ? ` kind=${err.kind}` : ''} retry=${willRetry}`,
      );
      if (willRetry) throw err;
      decision = {
        status: 'NEEDS_HUMAN_REVIEW',
        reviewReason: isTransport ? 'PROVIDER_FAILURE' : 'INTERNAL_ERROR',
        result: null,
      };
    }

    const written = await this.finish(inquiryId, decision);
    this.logger.log(
      `${tag} ${decision.status}${decision.status === 'NEEDS_HUMAN_REVIEW' ? `(${decision.reviewReason})` : ''} in ${Math.round(performance.now() - started)}ms${written ? '' : ' (already terminal, not overwritten)'}`,
    );
  }

  /**
   * Conditional final write: only an inquiry that is still open is updated, so a late duplicate
   * job can never overwrite a terminal state. Returns false when another run got there first.
   */
  private async finish(
    inquiryId: string,
    decision: TriageDecision,
  ): Promise<boolean> {
    const { count } = await this.prisma.inquiry.updateMany({
      where: { id: inquiryId, status: { in: OPEN_STATUSES } },
      data: {
        status: decision.status,
        reviewReason:
          decision.status === 'NEEDS_HUMAN_REVIEW'
            ? decision.reviewReason
            : null,
        result: decision.result ?? Prisma.DbNull,
        processedAt: new Date(),
      },
    });
    return count === 1;
  }
}
