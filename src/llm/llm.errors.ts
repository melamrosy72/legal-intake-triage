export type LlmTransportErrorKind =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'AUTH'
  | 'BAD_REQUEST';

/** A normalized provider failure. The message is the kind only, so it is always safe to log. */
export class LlmTransportError extends Error {
  constructor(
    readonly kind: LlmTransportErrorKind,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(kind);
    this.name = 'LlmTransportError';
  }

  /** Spec §7 mapping from an HTTP status (or an error code embedded in a 200 body). */
  static fromStatus(status: number, retryAfterMs?: number): LlmTransportError {
    if (status === 429) {
      return new LlmTransportError('RATE_LIMITED', true, status, retryAfterMs);
    }
    if (status === 408 || status >= 500) {
      return new LlmTransportError('SERVER_ERROR', true, status);
    }
    if (status === 401 || status === 403) {
      return new LlmTransportError('AUTH', false, status);
    }
    return new LlmTransportError('BAD_REQUEST', false, status);
  }
}
