// Raw JSON-RPC client (spec §5.7): plain fetch, one request per call (no batches: they add no capacity and fail
// per element), per-method-class pacing, Retry-After on 429, bounded retries on 5xx / network / timeout.
// Never routes transactions through web3.js 1.x, which cannot read transaction version 1 (SIMD-0385).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { methodClass, Pacer, realClock, type Clock } from './limiter.js';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code: number | null,
    readonly httpStatus: number | null,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcClientOptions {
  url: string;
  heavyRps: number;
  lightRps: number;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Dev only: cache getTransaction results as <dir>/<signature>.json. Never set in Actions. */
  txCacheDir?: string | null;
  max429Retries?: number;
}

/** A URL safe to print: scheme and host only; paths and query strings often carry API keys. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname && parsed.pathname !== '/' ? '/…' : '';
    const query = parsed.search ? '?…' : '';
    return `${parsed.protocol}//${parsed.host}${path}${query}`;
  } catch {
    return '<invalid url>';
  }
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('<redacted>');
  }
  return out;
}

const BACKOFF_5XX_MS = [1000, 2000, 4000];

export class RpcClient {
  readonly label: string;
  readonly calls: Record<string, number> = {};
  readonly throttles: Record<string, number> = {};
  private readonly pacers: Record<'heavy' | 'light', Pacer>;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly txCacheDir: string | null;
  private readonly max429Retries: number;
  private id = 0;

  constructor(private readonly options: RpcClientOptions) {
    this.label = redactUrl(options.url);
    this.clock = options.clock ?? realClock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.log = options.log ?? (() => undefined);
    this.txCacheDir = options.txCacheDir ?? null;
    this.max429Retries = options.max429Retries ?? 6;
    this.pacers = {
      heavy: new Pacer(options.heavyRps, this.clock),
      light: new Pacer(options.lightRps, this.clock),
    };
    if (this.txCacheDir && !existsSync(this.txCacheDir)) mkdirSync(this.txCacheDir, { recursive: true });
  }

  get url(): string {
    return this.options.url;
  }

  rate(kind: 'heavy' | 'light'): number {
    return this.pacers[kind].currentRate;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const cached = this.readCache<T>(method, params);
    if (cached !== undefined) return cached;
    const pacer = this.pacers[methodClass(method)];
    let throttled = 0;
    let transient = 0;
    for (;;) {
      await pacer.take();
      this.calls[method] = (this.calls[method] ?? 0) + 1;
      let response: Response;
      try {
        response = await this.post(method, params);
      } catch (error) {
        if (transient < BACKOFF_5XX_MS.length) {
          const wait = BACKOFF_5XX_MS[transient++];
          this.log(`[rpc ${this.label}] ${method} network error (${errorText(error)}); retry in ${wait} ms`);
          await this.clock.sleep(wait);
          continue;
        }
        throw new RpcError(`${method}: network error: ${errorText(error)}`, method, null, null);
      }
      const retryAfterMs = retryAfter(response.headers.get('retry-after'));
      if (response.status === 429) {
        if (throttled >= this.max429Retries) {
          throw new RpcError(`${method}: still rate limited after ${throttled} retries`, method, 429, 429);
        }
        throttled += 1;
        this.throttles[method] = (this.throttles[method] ?? 0) + 1;
        pacer.throttled(retryAfterMs);
        this.log(`[rpc ${this.label}] ${method} 429; waiting ${retryAfterMs} ms, rate now ${pacer.currentRate.toFixed(2)}/s`);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        if (transient < BACKOFF_5XX_MS.length) {
          const wait = BACKOFF_5XX_MS[transient++];
          this.log(`[rpc ${this.label}] ${method} HTTP ${response.status}; retry in ${wait} ms`);
          await this.clock.sleep(wait);
          continue;
        }
        throw new RpcError(`${method}: HTTP ${response.status}`, method, null, response.status);
      }
      let body: { result?: T; error?: { code: number; message: string; data?: unknown } };
      try {
        body = (await response.json()) as typeof body;
      } catch (error) {
        if (transient < BACKOFF_5XX_MS.length) {
          const wait = BACKOFF_5XX_MS[transient++];
          await this.clock.sleep(wait);
          continue;
        }
        throw new RpcError(`${method}: invalid JSON (HTTP ${response.status}): ${errorText(error)}`, method, null, response.status);
      }
      if (body.error) {
        if (body.error.code === 429) {
          if (throttled >= this.max429Retries) {
            throw new RpcError(`${method}: still rate limited after ${throttled} retries`, method, 429, response.status);
          }
          throttled += 1;
          this.throttles[method] = (this.throttles[method] ?? 0) + 1;
          pacer.throttled(retryAfterMs);
          continue;
        }
        throw new RpcError(`${method}: ${body.error.message} (${body.error.code})`, method, body.error.code,
          response.status, body.error.data ?? null);
      }
      if (!response.ok) {
        throw new RpcError(`${method}: HTTP ${response.status}`, method, null, response.status);
      }
      pacer.succeeded();
      const result = body.result as T;
      this.writeCache(method, params, result);
      return result;
    }
  }

  totalCalls(): number {
    return Object.values(this.calls).reduce((sum, n) => sum + n, 0);
  }

  private async post(method: string, params: unknown[]): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private cachePath(method: string, params: unknown[]): string | null {
    if (!this.txCacheDir || method !== 'getTransaction' || typeof params[0] !== 'string') return null;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(params[0])) return null;
    return join(this.txCacheDir, `${params[0]}.json`);
  }

  private readCache<T>(method: string, params: unknown[]): T | undefined {
    const path = this.cachePath(method, params);
    if (!path || !existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private writeCache(method: string, params: unknown[], result: unknown): void {
    const path = this.cachePath(method, params);
    if (!path || result === null || result === undefined) return;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(result));
    renameSync(tmp, path);
  }
}

function retryAfter(header: string | null): number {
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 10_000;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? 'timeout' : error.message;
  return String(error);
}

/** Codes meaning "this endpoint does not have it": try the archival endpoint. */
export function isMissingHistoryError(error: unknown): boolean {
  return error instanceof RpcError && (error.code === -32007 || error.code === -32009 || error.code === -32004 ||
    error.code === -32011 || error.code === -32014);
}
