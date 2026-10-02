// Per-method-class pacing for one RPC endpoint (spec §5.7). The public endpoints meter getTransaction,
// getSignaturesForAddress, getProgramAccounts and getBlockTime at 10 per 10 s per IP, and the account reads at
// 50 per 10 s. A pacer spaces calls 1/rate apart; on a 429 the rate is halved (floor 0.25/s) and it creeps back
// after a run of successes.

export type MethodClass = 'heavy' | 'light';

const HEAVY_METHODS = new Set(['getTransaction', 'getSignaturesForAddress', 'getProgramAccounts', 'getBlockTime']);

export function methodClass(method: string): MethodClass {
  return HEAVY_METHODS.has(method) ? 'heavy' : 'light';
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const MIN_RATE = 0.25;

export class Pacer {
  private rate: number;
  private nextAt = 0;
  private successes = 0;

  constructor(
    private readonly baseRate: number,
    private readonly clock: Clock = realClock,
  ) {
    if (!(baseRate > 0)) throw new Error(`rate must be positive, got ${baseRate}`);
    this.rate = baseRate;
  }

  get currentRate(): number {
    return this.rate;
  }

  /** Waits for this caller's slot. Slots are reserved synchronously, so concurrent callers queue up in order. */
  async take(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + 1000 / this.rate;
    if (at > now) await this.clock.sleep(at - now);
  }

  /** A 429: halve the rate and push the next slot past the server's Retry-After. */
  throttled(retryAfterMs: number): void {
    this.rate = Math.max(MIN_RATE, this.rate / 2);
    this.successes = 0;
    this.nextAt = Math.max(this.nextAt, this.clock.now() + retryAfterMs);
  }

  succeeded(): void {
    this.successes += 1;
    if (this.successes >= 20 && this.rate < this.baseRate) {
      this.rate = Math.min(this.baseRate, this.rate * 1.5);
      this.successes = 0;
    }
  }
}
