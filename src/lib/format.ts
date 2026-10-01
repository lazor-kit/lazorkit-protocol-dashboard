// Display formatting for the dashboard (spec §11.1). Pure functions, no DOM.
//   Lamports: below 0.001 SOL show "n lamports", otherwise SOL with up to 4 decimals; exact lamports go in tooltips.
//   Times: UTC, with a relative age next to them.
//   Explorer: https://explorer.solana.com/{tx|address}/<id>, plus ?cluster=devnet on devnet.

import type { Cluster, Lamports } from '../types/dashboard';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SMALL_LAMPORTS = 1_000_000n; // 0.001 SOL
const integerFormat = new Intl.NumberFormat('en-US');

export function toBigInt(value: Lamports | bigint | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.round(value));
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? BigInt(trimmed) : 0n;
}

export function formatInteger(value: number | bigint | string | null | undefined): string {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'string') return integerFormat.format(toBigInt(value));
  return integerFormat.format(value);
}

/** "2,215,000 lamports" below 0.001 SOL, otherwise "0.0022 SOL" (at most 4 decimals, rounded half up). */
export function formatLamports(value: Lamports | bigint | number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  const lamports = toBigInt(value);
  if (lamports === 0n) return '0 SOL';
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  if (abs < SMALL_LAMPORTS) return `${negative ? '−' : ''}${integerFormat.format(abs)} lamports`;
  const tenThousandths = (abs + 50_000n) / 100_000n; // 1e-4 SOL units, rounded
  const whole = tenThousandths / 10_000n;
  const fraction = (tenThousandths % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '−' : ''}${integerFormat.format(whole)}${fraction ? `.${fraction}` : ''} SOL`;
}

/** The exact amount, for title tooltips. */
export function exactLamports(value: Lamports | bigint | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return `${integerFormat.format(toBigInt(value))} lamports`;
}

export function lamportsToSol(value: Lamports | bigint | number): number {
  return Number(toBigInt(value)) / Number(LAMPORTS_PER_SOL);
}

/** Axis tick for a SOL amount with a fixed number of decimals (chosen from the tick step). */
export function formatSolAxis(sol: number, decimals = 4): string {
  if (sol === 0) return '0';
  return sol.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  const value = ratio * 100;
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0 && value > 0) return `<${(10 ** -digits).toFixed(digits)}%`;
  return `${rounded.toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Percentage change, or null when there is no previous value to compare with. */
export function percentChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (current - previous) / previous;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "18:58 UTC" when the instant is on the same UTC day as `now`, else "2026-09-27 17:14 UTC". */
export function formatUtc(iso: string | null | undefined, now: number = Date.now(), options: { seconds?: boolean; alwaysDate?: boolean } = {}): string {
  const date = parse(iso);
  if (!date) return '–';
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${options.seconds ? `:${pad(date.getUTCSeconds())}` : ''}`;
  const day = utcDay(date);
  if (!options.alwaysDate && day === utcDay(new Date(now))) return `${time} UTC`;
  return `${day} ${time} UTC`;
}

export function utcDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** "just now", "38 min ago", "9 h ago", "4 days ago"; future instants count as "just now". */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parse(iso);
  if (!date) return '–';
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours < 10 ? Number(hours.toFixed(1)).toString() : Math.round(hours)} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '–';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function shortenAddress(address: string | null | undefined, chars = 4): string {
  if (!address) return '–';
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function shortHash(sha256: string | null | undefined, chars = 8): string {
  if (!sha256) return '–';
  return `${sha256.slice(0, chars)}…`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–';
  return `${integerFormat.format(bytes)} B`;
}

export function explorerAddressUrl(address: string, cluster: Cluster): string {
  return `https://explorer.solana.com/address/${address}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}

export function explorerTxUrl(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}
