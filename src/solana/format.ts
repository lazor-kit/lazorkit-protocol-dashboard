import type { ClusterId } from './constants';

const LAMPORTS_PER_SOL = 1_000_000_000n;

function toBigInt(value: bigint | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function formatInteger(value: number | bigint | string): string {
  if (typeof value === 'string') {
    return new Intl.NumberFormat('en-US').format(BigInt(value));
  }
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatLamports(lamports: bigint | string): string {
  const amount = toBigInt(lamports);
  const whole = amount / LAMPORTS_PER_SOL;
  const fraction = amount % LAMPORTS_PER_SOL;
  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return fractionText.length > 0
    ? `${formatInteger(whole)}.${fractionText} SOL`
    : `${formatInteger(whole)} SOL`;
}

export function formatLamportsShort(lamports: bigint | string): string {
  const amount = toBigInt(lamports);
  const sol = Number(amount) / Number(LAMPORTS_PER_SOL);
  if (sol === 0) return '0 SOL';
  if (sol < 0.000001) return `${amount.toString()} lamports`;
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 6,
  }).format(sol)} SOL`;
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function explorerUrl(address: string, cluster: ClusterId): string {
  const base = `https://explorer.solana.com/address/${address}`;
  if (cluster === 'mainnet') return base;
  if (cluster === 'devnet') return `${base}?cluster=devnet`;
  return base;
}

export function formatDateTime(date: Date | string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(typeof date === 'string' ? new Date(date) : date);
}
