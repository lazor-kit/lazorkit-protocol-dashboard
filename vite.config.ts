import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { getDashboardStats, parseDashboardWindow } from './api/_lib/analytics';
import { getCronSecret } from './api/_lib/env';
import { runIndexer } from './api/_lib/indexer';
import { getCachedProtocolStats, CACHE_TTL_SECONDS } from './api/_lib/protocolStats';
import { isClusterId } from './src/solana/shared';
import { isDashboardWindow } from './src/solana/dashboardTypes';

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [protocolStatsDevApi(), react()],
    test: {
      environment: 'node',
      globals: true,
    },
  };
});

function protocolStatsDevApi(): Plugin {
  return {
    name: 'protocol-stats-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/protocol-stats', async (request, response) => {
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.setHeader('allow', 'GET');
          response.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const requestUrl = new URL(request.url ?? '', 'http://localhost');
        const cluster = requestUrl.searchParams.get('cluster') ?? 'mainnet';
        response.setHeader('content-type', 'application/json');

        if (!isClusterId(cluster)) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Unsupported cluster' }));
          return;
        }

        try {
          const stats = await getCachedProtocolStats(cluster);
          response.setHeader(
            'cache-control',
            `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=120`,
          );
          response.end(JSON.stringify(stats));
        } catch (error) {
          response.statusCode = 502;
          response.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to fetch protocol stats',
            }),
          );
        }
      });
      server.middlewares.use('/api/dashboard', async (request, response) => {
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.setHeader('allow', 'GET');
          response.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const requestUrl = new URL(request.url ?? '', 'http://localhost');
        const cluster = requestUrl.searchParams.get('cluster') ?? 'mainnet';
        const window = requestUrl.searchParams.get('window') ?? '24h';
        response.setHeader('content-type', 'application/json');

        if (!isClusterId(cluster)) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Unsupported cluster' }));
          return;
        }
        if (!isDashboardWindow(window)) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Unsupported window' }));
          return;
        }

        try {
          const stats = await getDashboardStats(cluster, parseDashboardWindow(window));
          response.setHeader(
            'cache-control',
            `s-maxage=${stats.health.cacheTtlSeconds}, stale-while-revalidate=120`,
          );
          response.end(JSON.stringify(stats));
        } catch (error) {
          response.statusCode = 502;
          response.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to build dashboard',
            }),
          );
        }
      });
      server.middlewares.use('/api/cron/indexer', async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.setHeader('allow', 'GET');
          response.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const secret = getCronSecret();
        const requestUrl = new URL(request.url ?? '', 'http://localhost');
        const providedSecret =
          requestUrl.searchParams.get('secret') ??
          request.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!secret || providedSecret !== secret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const clusterParam = requestUrl.searchParams.get('cluster') ?? 'all';
        const clusters =
          clusterParam === 'all'
            ? (['mainnet', 'devnet'] as const)
            : isClusterId(clusterParam)
              ? [clusterParam]
              : [];
        if (clusters.length === 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Unsupported cluster' }));
          return;
        }

        try {
          const results = [];
          for (const cluster of clusters) {
            results.push(await runIndexer(cluster));
          }
          response.end(JSON.stringify({ results }));
        } catch (error) {
          response.statusCode = 502;
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Indexer failed',
            }),
          );
        }
      });
    },
  };
}
