import { type ClusterId } from '../../src/solana/shared';

const DEFAULT_RPC_URLS: Record<ClusterId, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
};

export function rpcUrlForCluster(cluster: ClusterId): string {
  const envKey = `${cluster.toUpperCase()}_RPC_URL`;
  return process.env[envKey] ?? DEFAULT_RPC_URLS[cluster];
}

export function getBackfillDays(): number {
  return readPositiveInteger('INDEXER_BACKFILL_DAYS', 60);
}

export function getIndexerMaxSignatures(): number {
  return readPositiveInteger('INDEXER_MAX_SIGNATURES_PER_RUN', 100);
}

export function getIndexerBackfillMaxPages(): number {
  return readPositiveInteger('INDEXER_BACKFILL_MAX_PAGES_PER_RUN', 1);
}

export function getIndexerParseDelayMs(): number {
  return readNonNegativeInteger('INDEXER_PARSE_DELAY_MS', 75);
}

export function getCronSecret(): string | null {
  return process.env.CRON_SECRET ?? null;
}

export function getSupabaseConfig():
  | { configured: true; url: string; serviceRoleKey: string }
  | { configured: false } {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return { configured: false };
  return { configured: true, url: url.replace(/\/$/, ''), serviceRoleKey };
}

function readPositiveInteger(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
