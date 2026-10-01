// App attribution (spec §6.5): the clientDataJSON a passkey signed, and the rpId in CreateWallet data.

const CDJ_PREFIX = new TextEncoder().encode('{"type":"webauthn.get"');
const utf8 = new TextDecoder('utf-8', { fatal: false });

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export interface ClientData {
  origin: string | null;
  topOrigin: string | null;
  crossOrigin: boolean;
}

/**
 * The passkey auth payload ends with [cdjLen u16][clientDataJSON] and must end exactly at the instruction data's
 * end (program source auth/secp256r1/mod.rs). Returns null when no well-formed clientDataJSON is present.
 */
export function extractClientData(data: Uint8Array): ClientData | null {
  const at = indexOf(data, CDJ_PREFIX);
  if (at < 2) return null;
  const length = data[at - 2] | (data[at - 1] << 8);
  if (at + length !== data.length) return null;
  try {
    const parsed = JSON.parse(utf8.decode(data.subarray(at, at + length))) as Record<string, unknown>;
    return {
      origin: typeof parsed.origin === 'string' ? parsed.origin : null,
      topOrigin: typeof parsed.topOrigin === 'string' ? parsed.topOrigin : null,
      crossOrigin: parsed.crossOrigin === true,
    };
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalises an origin or rpId to an app id:
 * - an http(s) URL becomes its host (the port is kept only for localhost);
 * - android:apk-key-hash:<h> becomes android:<first 8 chars of h>;
 * - an rpId already shaped like a host stays as is; a scheme prefix (seen on devnet v1) is stripped.
 */
export function normalizeApp(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const android = /^android:apk-key-hash:(.+)$/.exec(trimmed);
  if (android) return `android:${android[1].slice(0, 8)}`;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      return LOCAL_HOSTS.has(host) && url.port ? `${host}:${url.port}` : host;
    } catch {
      return trimmed.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase() || null;
    }
  }
  const host = trimmed.split('/')[0].toLowerCase();
  return host.length > 0 && host.length <= 253 ? host : null;
}

export function appFromClientData(data: Uint8Array): { app: string | null; found: boolean } {
  const clientData = extractClientData(data);
  if (!clientData) return { app: null, found: false };
  return { app: normalizeApp(clientData.topOrigin ?? clientData.origin), found: true };
}

/** CreateWallet with a Secp256r1 owner: [106] rpIdLen, [107..107+len] rpId (UTF-8). */
export function rpIdFromCreateWallet(data: Uint8Array): { rpId: string | null; short: boolean } {
  if (data.length < 107) return { rpId: null, short: true };
  const length = data[106];
  if (107 + length > data.length || length === 0) return { rpId: null, short: true };
  return { rpId: utf8.decode(data.subarray(107, 107 + length)), short: false };
}
