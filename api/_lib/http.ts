// Minimal request/response shapes shared by the Vercel functions and api/dev-server.ts.

export type QueryValue = string | string[] | undefined;

export interface ApiRequest {
  method?: string;
  query: Record<string, QueryValue>;
  headers?: Record<string, QueryValue>;
}

export interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): {
    json(body: unknown): void;
  };
}

export function first(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function header(request: ApiRequest, name: string): string | undefined {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return first(direct);
}

export function methodNotAllowed(request: ApiRequest, response: ApiResponse): boolean {
  if (request.method && request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return true;
  }
  return false;
}
