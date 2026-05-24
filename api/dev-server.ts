import { createServer, type IncomingHttpHeaders } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dashboardHandler from './dashboard';
import protocolStatsHandler from './protocol-stats';
import cronIndexerHandler from './cron/indexer';

type QueryValue = string | string[] | undefined;

interface ApiRequest {
  method?: string;
  query: Record<string, QueryValue>;
  headers: Record<string, QueryValue>;
}

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): {
    json(body: unknown): void;
  };
}

type ApiHandler = (
  request: ApiRequest,
  response: ApiResponse,
) => Promise<void> | void;

const routes: Record<string, ApiHandler> = {
  '/api/dashboard': dashboardHandler,
  '/api/protocol-stats': protocolStatsHandler,
  '/api/cron/indexer': cronIndexerHandler,
};

loadLocalEnv();

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.API_PORT ?? '8787', 10);

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);
  const route = routes[requestUrl.pathname];

  response.setHeader('access-control-allow-origin', 'http://127.0.0.1:5173');
  response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    logRequest(request.method, requestUrl, 204, startedAt);
    return;
  }

  if (!route) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    logRequest(request.method, requestUrl, 404, startedAt);
    return;
  }

  let statusCode = 200;
  let sent = false;
  const apiResponse: ApiResponse = {
    setHeader(name, value) {
      response.setHeader(name, value);
    },
    status(code) {
      statusCode = code;
      return {
        json(body) {
          if (sent) {
            return;
          }
          sent = true;
          response.writeHead(statusCode, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
          logRequest(request.method, requestUrl, statusCode, startedAt);
        },
      };
    },
  };

  try {
    await route(
      {
        method: request.method,
        query: queryFromSearchParams(requestUrl.searchParams),
        headers: headersToRecord(request.headers),
      },
      apiResponse,
    );

    if (!sent) {
      response.writeHead(statusCode);
      response.end();
      logRequest(request.method, requestUrl, statusCode, startedAt);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: message }));
    logRequest(request.method, requestUrl, 500, startedAt);
  }
});

server.listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port}`);
  console.log('[api] routes: /api/dashboard, /api/protocol-stats, /api/cron/indexer');
});

function queryFromSearchParams(params: URLSearchParams): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const [key, value] of params) {
    const existing = query[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing !== undefined) {
      query[key] = [existing, value];
    } else {
      query[key] = value;
    }
  }
  return query;
}

function headersToRecord(headers: IncomingHttpHeaders): Record<string, QueryValue> {
  const record: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'number') {
      record[key] = String(value);
    } else {
      record[key] = value;
    }
  }
  return record;
}

function loadLocalEnv() {
  const loaded = {
    ...readEnvFile('.env'),
    ...readEnvFile('.env.local'),
  };

  for (const [key, value] of Object.entries(loaded)) {
    process.env[key] ??= value;
  }
}

function readEnvFile(fileName: string): Record<string, string> {
  try {
    const content = readFileSync(resolve(process.cwd(), fileName), 'utf8');
    const values: Record<string, string> = {};

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      values[key] = unquote(rawValue);
    }

    return values;
  } catch {
    return {};
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function logRequest(
  method: string | undefined,
  requestUrl: URL,
  statusCode: number,
  startedAt: number,
) {
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[api] ${method ?? 'GET'} ${requestUrl.pathname}${requestUrl.search} ${statusCode} ${elapsedMs}ms`,
  );
}
