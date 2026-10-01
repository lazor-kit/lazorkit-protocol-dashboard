// Worker entry point: `npm run indexer -- [--mode incremental|reparse|rebuild|verify] [--program 1-4]
// [--cluster mainnet|devnet|all] [--budget-minutes N]`. Exit codes (spec §5.10): 0 ok / lagging with progress /
// not deployed; 1 a program failed, made no progress for 3 runs, or lk_verify found a mismatch; 2 the database
// schema is missing or too old.

import { appendFileSync } from 'node:fs';
import { loadApiEnv } from '../scripts/loadApiEnv.js';
import { PARSER_VERSION } from './chain/constants.js';
import { ConfigError, isPublicEndpoint, loadConfig, PUBLIC_RATES, secretsOf, type WorkerConfig } from './config.js';
import { PostgrestLkDb } from './db/client.js';
import { runWorker, type Lane, type WorkerResult } from './loop/run.js';
import { redactText, RpcClient } from './rpc/client.js';

function makeLane(config: WorkerConfig, cluster: 'mainnet' | 'devnet', log: (line: string) => void): Lane {
  const urls = config.rpc[cluster];
  const primaryRates = isPublicEndpoint(urls.primary)
    ? PUBLIC_RATES
    : { heavy: config.primaryRps, light: config.primaryRps * 2 };
  const primary = new RpcClient({
    url: urls.primary,
    heavyRps: primaryRates.heavy,
    lightRps: primaryRates.light,
    log,
    txCacheDir: config.txCacheDir,
  });
  const archival =
    urls.archival === urls.primary
      ? primary
      : new RpcClient({
          url: urls.archival,
          heavyRps: isPublicEndpoint(urls.archival) ? PUBLIC_RATES.heavy : config.primaryRps,
          lightRps: isPublicEndpoint(urls.archival) ? PUBLIC_RATES.light : config.primaryRps * 2,
          log,
          txCacheDir: config.txCacheDir,
        });
  return { primary, archival };
}

function summaryMarkdown(result: WorkerResult, config: WorkerConfig): string {
  const lines = [
    `## LazorKit dashboard indexer (${config.mode})`,
    '',
    `Run \`${result.runId}\` · ${result.startedAt} → ${result.finishedAt} (${Math.round(result.durationMs / 1000)} s) · exit ${result.exitCode}: ${result.message}`,
    '',
    '| program | status | binary | discovered (new) | ingested | pending | gaps | state slot | checks | verify |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const p of result.programs) {
    const checks = (p.checks as Array<{ id: string; ok: boolean | null; mode: string }>)
      .map((c) => `${c.id}:${c.mode === 'pending' ? '…' : c.ok ? '✓' : '✗'}`)
      .join(' ');
    lines.push(
      `| ${p.label} | ${p.status} | ${p.binaryKind ?? '–'} | ${p.discovered} (${p.queued}) | ${p.ingested} | ${p.pending ?? '–'} | ` +
        `${p.convertedToGaps}/${p.gapsRepaired} | ${p.stateSlot ?? '–'} | ${checks || '–'} | ` +
        `${p.verify ? `${p.verify.mismatches} mismatches / ${p.verify.daysChecked} days` : '–'} |`,
    );
  }
  const errors = result.programs.flatMap((p) => p.errors.map((e) => `- ${p.label}: ${e}`));
  const warnings = result.programs.flatMap((p) => p.warnings.slice(0, 5).map((w) => `- ${p.label}: ${w}`));
  if (errors.length) lines.push('', '**Errors**', '', ...errors);
  if (warnings.length) lines.push('', '**Parser warnings** (fix with a PARSER_VERSION bump + mode=reparse)', '', ...warnings);
  lines.push('', '**RPC calls**', '', '```', JSON.stringify(result.rpcCalls), '```', '');
  return lines.join('\n');
}

async function main(): Promise<number> {
  loadApiEnv(); // local development: .env.api / .env.api.local (never present in Actions)
  let config: WorkerConfig;
  try {
    config = loadConfig(process.env, process.argv.slice(2));
  } catch (error) {
    console.error(`[worker] ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof ConfigError ? 2 : 1;
  }
  const secrets = secretsOf(config);
  const log = (line: string) => console.log(redactText(line, secrets));
  const lanes = { mainnet: makeLane(config, 'mainnet', log), devnet: makeLane(config, 'devnet', log) };
  for (const [cluster, lane] of Object.entries(lanes)) {
    log(`[worker] ${cluster}: primary ${lane.primary.label} (${lane.primary.rate('heavy')}/s heavy)` +
      `${lane.archival === lane.primary ? ' = archival' : `, archival ${lane.archival.label}`}`);
  }
  const runId = [process.env.GITHUB_RUN_ID ?? 'local', process.env.GITHUB_RUN_ATTEMPT, new Date().toISOString()]
    .filter(Boolean)
    .join('-');
  const db = new PostgrestLkDb(config.supabaseUrl, config.supabaseKey);
  let result: WorkerResult;
  try {
    result = await runWorker(
      { db, lanes },
      {
        mode: config.mode,
        program: config.program,
        cluster: config.cluster,
        budgetMs: config.budgetMinutes * 60_000,
        reserveMs: Math.min(45_000, config.budgetMinutes * 60_000 * 0.2),
        retentionDays: config.retentionDays,
        runId,
        parserVersion: PARSER_VERSION,
        log,
        now: () => Date.now(),
      },
    );
  } catch (error) {
    console.error(redactText(`[worker] run failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, secrets));
    return 1;
  }
  console.log(redactText(JSON.stringify({ ...result, programs: result.programs.map((p) => ({ ...p, warnings: p.warnings.length })) }, null, 2), secrets));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, redactText(summaryMarkdown(result, config), secrets));
  if (result.exitCode === 2) console.error(`[worker] ${result.message}`);
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[worker] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
