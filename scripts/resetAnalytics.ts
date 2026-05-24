import { loadApiEnv } from './loadApiEnv';
import { getSupabaseConfig } from '../api/_lib/env';

loadApiEnv();

const config = getSupabaseConfig();
if (!config.configured) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}
const supabaseUrl = config.url;
const serviceRoleKey = config.serviceRoleKey;

const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  'content-type': 'application/json',
};

void main();

async function main() {
  await request('/rest/v1/protocol_transactions?cluster=not.is.null', {
    method: 'DELETE',
  });
  await request('/rest/v1/indexer_cursors?cluster=not.is.null', {
    method: 'DELETE',
  });
  await request('/rest/v1/protocol_snapshots?cluster=not.is.null', {
    method: 'DELETE',
  });

  console.log(
    'Reset analytics tables: protocol_transactions, indexer_cursors, protocol_snapshots',
  );
}

async function request(path: string, init: RequestInit) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase reset failed ${response.status}: ${body}`);
  }
}
