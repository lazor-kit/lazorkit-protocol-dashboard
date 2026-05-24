import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { getCachedProtocolStats, CACHE_TTL_SECONDS } from './api/_lib/protocolStats';
import { isClusterId } from './src/solana/shared';

export default defineConfig({
  plugins: [protocolStatsDevApi(), react()],
  test: {
    environment: 'node',
    globals: true,
  },
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
    },
  };
}
