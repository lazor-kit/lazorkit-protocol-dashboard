import { getCachedProtocolStats, CACHE_TTL_SECONDS } from './_lib/protocolStats';
import { isClusterId } from '../src/solana/shared';

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
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

  const clusterParam = Array.isArray(request.query.cluster)
    ? request.query.cluster[0]
    : request.query.cluster;
  const cluster = clusterParam ?? 'mainnet';

  if (!isClusterId(cluster)) {
    return response.status(400).json({ error: 'Unsupported cluster' });
  }

  try {
    const stats = await getCachedProtocolStats(cluster);
    response.setHeader(
      'cache-control',
      `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=120`,
    );
    return response.status(200).json(stats);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to fetch protocol stats';
    return response.status(502).json({ error: message });
  }
}
