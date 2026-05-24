interface ApiRequest {
  method?: string;
}

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): {
    json(body: unknown): void;
  };
}

export default function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  response.setHeader('cache-control', 'no-store');
  return response.status(410).json({
    error: 'Indexer cron is disabled on Vercel',
    message:
      'LazorKit dashboard indexing runs from GitHub Actions. Vercel APIs are read-only Supabase endpoints.',
  });
}
