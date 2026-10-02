// Worker configuration from the environment and CLI flags. Secrets are read here and never printed.

import type { WorkerMode } from './loop/run.js';

export const PUBLIC_RPC = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
} as const;

/** The public endpoints allow 10 heavy calls (getTransaction, getSignaturesForAddress, ...) per 10 s per IP. */
export const PUBLIC_RATES = { heavy: 1, light: 4 } as const;

export interface WorkerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  rpc: Record<'mainnet' | 'devnet', { primary: string; archival: string }>;
  primaryRps: number;
  retentionDays: number;
  txCacheDir: string | null;
  mode: WorkerMode;
  program: number | null;
  cluster: 'mainnet' | 'devnet' | 'all';
  budgetMinutes: number;
}

export class ConfigError extends Error {}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return undefined;
  const arg = argv[index];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return argv[index + 1];
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): WorkerConfig {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) throw new ConfigError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

  const mode = (flag(argv, 'mode') ?? env.INDEXER_MODE ?? 'incremental').trim() as WorkerMode;
  if (!['incremental', 'reparse', 'rebuild', 'verify'].includes(mode)) throw new ConfigError(`unknown mode "${mode}"`);
  const programRaw = (flag(argv, 'program') ?? env.INDEXER_PROGRAM ?? '').trim();
  const program = programRaw === '' || programRaw === 'all' ? null : Number(programRaw);
  if (program !== null && ![1, 2, 3, 4].includes(program)) throw new ConfigError(`program must be 1-4, got "${programRaw}"`);
  if (mode === 'rebuild' && program === null) throw new ConfigError('mode=rebuild needs --program 1|2|3|4');
  const cluster = (flag(argv, 'cluster') ?? env.INDEXER_CLUSTER ?? 'all').trim() as WorkerConfig['cluster'];
  if (!['mainnet', 'devnet', 'all'].includes(cluster)) throw new ConfigError(`unknown cluster "${cluster}"`);

  const retentionDays = Math.floor(positiveNumber(env.INDEXER_EVENT_RETENTION_DAYS, 35, 'INDEXER_EVENT_RETENTION_DAYS'));
  // lk_compact refuses less: the 30d comparison reads the events of the day 30 days ago
  if (retentionDays < 31) throw new ConfigError('INDEXER_EVENT_RETENTION_DAYS must be at least 31');

  return {
    supabaseUrl,
    supabaseKey,
    rpc: {
      mainnet: {
        primary: env.MAINNET_RPC_URL?.trim() || PUBLIC_RPC.mainnet,
        archival: env.MAINNET_ARCHIVE_RPC_URL?.trim() || PUBLIC_RPC.mainnet,
      },
      devnet: {
        primary: env.DEVNET_RPC_URL?.trim() || PUBLIC_RPC.devnet,
        archival: env.DEVNET_ARCHIVE_RPC_URL?.trim() || PUBLIC_RPC.devnet,
      },
    },
    primaryRps: positiveNumber(env.INDEXER_PRIMARY_RPS, 4, 'INDEXER_PRIMARY_RPS'),
    retentionDays,
    txCacheDir: env.INDEXER_TX_CACHE_DIR?.trim() || null,
    mode,
    program,
    cluster,
    budgetMinutes: positiveNumber(flag(argv, 'budget-minutes') ?? env.INDEXER_BUDGET_MINUTES, 10, 'budget minutes'),
  };
}

export function isPublicEndpoint(url: string): boolean {
  return url === PUBLIC_RPC.mainnet || url === PUBLIC_RPC.devnet;
}

export function secretsOf(config: WorkerConfig): string[] {
  return [
    config.supabaseKey,
    config.rpc.mainnet.primary,
    config.rpc.devnet.primary,
    config.rpc.mainnet.archival,
    config.rpc.devnet.archival,
  ].filter((value) => !isPublicEndpoint(value));
}
