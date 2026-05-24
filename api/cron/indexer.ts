import { getCronSecret } from '../_lib/env.js';
import { runIndexer } from '../_lib/indexer.js';
import { isClusterId, type ClusterId } from '../../src/solana/shared.js';

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): {
    json(body: unknown): void;
  };
}

export default async function handler(
  request: ApiRequest,
  response: ApiResponse,
) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const secret = getCronSecret();
  const providedSecret =
    firstQueryValue(request.query.secret) ??
    firstHeaderValue(request.headers.authorization)?.replace(/^Bearer\s+/i, '');

  if (!secret || providedSecret !== secret) {
    return response.status(401).json({ error: 'Unauthorized' });
  }

  const clusterParam = firstQueryValue(request.query.cluster) ?? 'all';
  const clusters: ClusterId[] =
    clusterParam === 'all'
      ? ['mainnet', 'devnet']
      : isClusterId(clusterParam)
        ? [clusterParam]
        : [];

  if (clusters.length === 0) {
    return response.status(400).json({ error: 'Unsupported cluster' });
  }

  try {
    const results = [];
    for (const cluster of clusters) {
      results.push(await runIndexer(cluster));
    }
    return response.status(200).json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Indexer failed';
    return response.status(502).json({ error: message });
  }
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
