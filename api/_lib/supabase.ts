// Read-only PostgREST access for the Vercel functions. Never imports worker code, @solana/web3.js or
// @lazorkit/*: the functions only read lk_* RPCs (plus the cron heartbeat write).

export type SupabaseErrorKind = 'not_configured' | 'schema_missing' | 'unavailable' | 'error';

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly kind: SupabaseErrorKind,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'SupabaseError';
  }
}

export interface SupabaseTarget {
  url: string;
  key: string;
}

/** Reads prefer a dedicated read key, then the anon key, then the service-role key (what exists today). */
export function readTarget(env: NodeJS.ProcessEnv = process.env): SupabaseTarget | null {
  const url = env.SUPABASE_URL?.trim();
  const key = (env.SUPABASE_READ_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

export function writeTarget(env: NodeJS.ProcessEnv = process.env): SupabaseTarget | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function isJwt(key: string): boolean {
  return key.split('.').length === 3;
}

export async function callRpc<T>(
  target: SupabaseTarget | null,
  fn: string,
  args: Record<string, unknown>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<T> {
  if (!target) throw new SupabaseError('Supabase is not configured', 'not_configured');
  const headers: Record<string, string> = {
    apikey: target.key,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (isJwt(target.key)) headers.authorization = `Bearer ${target.key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 9000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${target.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch (error) {
    throw new SupabaseError(
      `database unreachable (${error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network error'})`,
      'unavailable',
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  if (response.ok) return (text ? JSON.parse(text) : null) as T;
  let code: string | null = null;
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null;
  } catch {
    code = null;
  }
  if (code === 'PGRST202' || code === '42883') {
    throw new SupabaseError(`function ${fn} is not in the schema cache`, 'schema_missing', response.status, code);
  }
  if (code === 'PGRST002' || response.status >= 500 || response.status === 404 || response.status === 408) {
    throw new SupabaseError(`database unavailable (HTTP ${response.status})`, 'unavailable', response.status, code);
  }
  throw new SupabaseError(`database request failed (HTTP ${response.status}${code ? ` ${code}` : ''})`, 'error', response.status, code);
}
