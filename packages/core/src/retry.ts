export interface BackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Lightweight exponential backoff helper intended for HTTP 429 / transient failures.
 * Keeps core logic dependency-free.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions & { getRetryAfterMs?: (e: unknown) => number | null } = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) break;

      const retryAfter = opts.getRetryAfterMs?.(e);
      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      const delay = Math.min(maxDelayMs, (retryAfter ?? exp) + jitter);

      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


