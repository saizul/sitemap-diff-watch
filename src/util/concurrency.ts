import { realClock, realSleep, type ClockFn, type SleepFn } from '../types.js';

/** Map over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Spaces calls evenly: at most `perSecond` starts per second across all callers.
 * `wait()` resolves when the caller may go.
 */
export class RateLimiter {
  private nextAt = 0;
  private readonly interval: number;

  constructor(
    perSecond: number,
    private readonly clock: ClockFn = realClock,
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!(perSecond > 0)) throw new RangeError('perSecond must be greater than 0');
    this.interval = 1000 / perSecond;
  }

  async wait(): Promise<void> {
    const now = this.clock();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.interval;
    if (at > now) await this.sleep(at - now);
  }
}
