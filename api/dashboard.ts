import {
  getDashboardStats,
  parseDashboardPagination,
  parseDashboardWindow,
} from './_lib/analytics';
import { isDashboardWindow } from '../src/solana/dashboardTypes';
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

  const cluster = firstQueryValue(request.query.cluster) ?? 'mainnet';
  const window = firstQueryValue(request.query.window) ?? '24h';
  const pagination = parseDashboardPagination({
    txPage: firstQueryValue(request.query.txPage),
    txLimit: firstQueryValue(request.query.txLimit),
  });

  if (!isClusterId(cluster)) {
    return response.status(400).json({ error: 'Unsupported cluster' });
  }
  if (!isDashboardWindow(window)) {
    return response.status(400).json({ error: 'Unsupported window' });
  }
  if (!pagination) {
    return response.status(400).json({ error: 'Unsupported pagination' });
  }

  try {
    const stats = await getDashboardStats(
      cluster,
      parseDashboardWindow(window),
      pagination,
    );
    response.setHeader(
      'cache-control',
      `s-maxage=${stats.health.cacheTtlSeconds}, stale-while-revalidate=120`,
    );
    return response.status(200).json(stats);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to build dashboard';
    return response.status(502).json({ error: message });
  }
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
