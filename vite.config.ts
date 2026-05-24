import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const env = loadWebEnv();
  Object.assign(process.env, env);
  const apiTarget =
    env.API_DEV_TARGET ?? `http://127.0.0.1:${env.API_PORT ?? '8787'}`;

  return {
    plugins: [react()],
    define: defineViteEnv(env),
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'node',
      globals: true,
    },
  };
});

function loadWebEnv(): Record<string, string> {
  return {
    ...readEnvFile('.env.web'),
    ...readEnvFile('.env.web.local'),
  };
}

function defineViteEnv(env: Record<string, string>): Record<string, string> {
  const definitions: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('VITE_')) {
      definitions[`import.meta.env.${key}`] = JSON.stringify(value);
    }
  }

  return definitions;
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
