// The SPA bundle never pulls in chain code, the worker or the Vercel functions: it only reads /api/dashboard.
// Sources are loaded with Vite's import.meta.glob, so this needs no Node APIs.

const sources = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/__fixtures__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function resolvePosix(fromFile: string, spec: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of spec.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

describe('src/** import guard', () => {
  it('found the SPA sources', () => {
    expect(Object.keys(sources)).toContain('/src/app/App.tsx');
  });

  it('never imports worker/, the root api/ functions, @solana/* or @lazorkit/*', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1];
        const target = spec.startsWith('.') ? resolvePosix(file, spec) : '';
        if (/^@solana\//.test(spec) || /^@lazorkit\//.test(spec) || target.startsWith('/worker/') || target.startsWith('/api/')) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
