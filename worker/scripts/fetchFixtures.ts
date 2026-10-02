// Fetches the parser test fixtures (read-only, public RPC, with backoff) into worker/__fixtures__/tx/.
// Each file is the raw getTransaction result (encoding json, maxSupportedTransactionVersion 1, finalized).
// Only missing files are fetched; INDEXER_TX_CACHE_DIR is consulted first when set.
//   npm run fixtures:fetch

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_RATES, PUBLIC_RPC } from '../config.js';
import { RpcClient } from '../rpc/client.js';

export const FIXTURE_SIGNATURES: Record<'mainnet-1' | 'devnet-3' | 'devnet-4', Record<string, string>> = {
  'mainnet-1': {
    createWalletPasskeySeedless: '2gwAN7DwdW7Mazn9chmxCQePpCfjV5VHaFbXd4YUudLbQsLDCXwVwdCMB4rEbegu5AWXf4bq8K7VCyon6EpG4Y1g',
    executeSession: '56SciB7niHVjM28C9N99NVSjLLYoHYugpZWn3UDNqnz28eUjUh3rwusuqHEnKM7F3iVDpoiXzgA7vPKGNf3vZG78',
    executePasskey: '2TscPMUGWAPJ1jpGLeyrSAnMmjyagubtNHVVFqmkm4mGBA78cFYV4bWzr6yoz44hVgtg3JKnVqhzX5X5xLAdZBa7',
    executeNoSuffixVaultToPayer: '3d9XBfekU8Yo4DWaSBXsb7RpRS2hAnEZeVgpoSyauivW8EfBtRLtSeDGXvfVGtPjjvfhGm17UMk64ZmRSy874hWc',
    authorize: '5a54KeZk3DU4muCQocYcEBsnYRNyP5211FNL38dsiXAC8gNPVgZQhxEt4xSJre8ozsnsGuveyVMub1RGgkZnbYwA',
    executeDeferred: '5wjBa1eiJMYu1FmzxPg6ZyuTUG54hpMRK9xMAE4DfpVpdMujReEz62jyYYbx9cPpeB1mC1A4ZhBa3QQjBVpvsQ2R',
    revokeThenCreateSession: '47ucxHzevtdmPtvWrdHaEb3wUpHevaXSZA7ZQaeh2GfpTVFVMZkNH3eaYprRkV7e75vviw5UWNZdUpp6EXgZTrS6',
    pingBotFailure: '2cJ6SppCAM5CdGEEkHFdiXFQPgxVsXi9fZrgusLrtRjfDTUAL7Yu4UMfFJEquXBNHC2s4sSx5FUCXAW1vJ2xtatB',
    createWalletDuplicate: '2gUcy9Q4eaNWMUArAFKbPWwuTabRaZabW5ymeKbHcpwsmB7DFqXTRuccVvkzM8QwQLui3dE9cDTZccFs6m6aH9b1',
    programMetadataWrite: '2iaL2FjyLGykZCYttALhJtm6QaDCigsQHAuuYqvGcbCNEyi3W8iDsVmPNyicUaCNC6tjakqZmx6PjBMnGXHB7v13',
    deploy: 'Z7R1yGfBtJPbWBti7neu9X9oFdTupGjxD1nT2xjX3iKQtDiAtuq8osLumk1RX1k2TVJJHWDUxo27n5eHE9w1coC',
    initializeTreasuryShard: '2cbLxLSzxSJzVNjhqMyiBq5SjZrxy2BivAWeGsd5fb9Y8KE377vNGMYehhJ6yWn58bvgPv4TRZPeU9Nqut1jpVsD',
    executeV0WithLookupTable: '21fjAScrPJQKwT7rpcTuaV8BKaAD19nepTTmwMmLLHDqFiDMLRenUC7FT68cSDVrhrkYRM3EA3EAtgJJrEvZsK98',
    executeAndroidOrigin: '2FNJRmziASBsyxLPZzAFCdFVytHrySPt8NuLe92h82Vizy9jeB91NhpZagxwYju9wqVRTQBNRTGfAP43mAQjrKaU',
    authorizeTopOrigin: '2BVuBKs5W2WHLrQ8jWbN3CgL9r3qbqckbDy12YCnbW84McG6H6MGRgu5hzQqcPbg2tgADp7AgtGwok5N1Hgcwm92',
    reclaimDeferred: '4VefVeehzdtokSXp7ZpRLSt8czjwKma8D1ebWXauqV7jSS672tbwQf3b9ePA8qnDPxgT5WwjH9zxDwmLrnakd3Tg',
  },
  'devnet-3': {
    registerPayerThenCreateWallet: '3zLVUZagmtqgwtCATCimKqmZtRVdVfx7qzbCTh65QUmCwibhpyxstFw8xiQoUSBnWmc3j5fDDH2vwhrnvvjnjX7G',
    eightReclaimDeferred: '4fRDuiPk48pQJ6NEDNJdbntnS4HTaKwHHXZGEX6oh9GGuoLxTpdQ7JFc64cSm1cjVoVvpWFAe9cPsZTJvQnvtAr2',
    executeCustom1: 'A2eKaq1GFmvvvndKcfFrwuaBB8JHEoGCWLLVvC11yxP8yw7e26E9kgAEB9pUj7Cq98xxwiAPBroBi9Wfums2pak',
    executeDeferredInvalidAccountData: '4nb5s3gnXw377nERxodFzqGTp6BqTgVdrJ19RPmqaVTStu6uaMkx1mxSbkphL7EpEpZKgY4UWc5Nm8PLU4G7XGhi',
    createWalletSchemeRpId: '4PMMKrBxRYD5MwXyA3gfNxWjD8S51NSDBSDZkFkhuCrrfc2HNyCPa81RdMDoUVtKhtUhtf8A8KjXK4oubwpUpqe',
    deploy: '4JB1KSbApA3sGiAGyUMDxCL6fKNaTm4sY7tnsXGbzq55Q4q4ssRYXJVMYFgN4yNnnp85BA4rAw6kjsYGZ3iT2v8S',
  },
  'devnet-4': {
    txV1ExecuteOk: '5oJVgxEnA4Mze99X62VFVxcAMnYAiBkPxBVgn58d1AnRkeGYhJHeidv3uFkqQMAMiyE1aH1BxgnQ3YYjHo7eFb36',
    txV1ExecuteDeferred58Keys: '4cozuyZnRqNKCoWj2XSMCDPkujxGp7hn9Nc4FPkbmeeEH2b71crFYhSQ2hxjk8uLXCjiMYqGgTK8kE5J2nfLcCQR',
    txV1MaxLoadedAccounts: '45XUcCTwryjZmMk6t4rASqdGxYM2Pc4t37aeNeJoLkkme3coZqeTCqjg774Pq6XPhw77g87eMAQ78Tai12FaYJWd',
    txV1ProgramFailedToComplete: '56cqbMsHYZrcptXbLSSMt2NqVbpfHUjZpYNriHbgLes1f2i9NsAy3nDxYD45145gPpgQuuqVaghdH9CTdPp869ft',
    signatureReused3006: 'FqVdDhKNCSzY45qVvoPUersbHtCk5NnLVdYmEMyppUDuRk9rm6nrn8b63o66MZRaM8PPLNG3ZFT5QBoCUuVUMLp',
    createWalletFeesUnconfigured: '2WhTqDPgYdEpEj8c92CyZFTgjfR3UDkKctHukC5fy2dFqSpRkRernkvjgapHJbwYguJ6HxPEo6YFGngwGfWmU66M',
    authorizeTopOriginLocalhost3000: '2F8HM2pD8DhZz86zmpCCXiURExpvdzSJyCDgJF9aFKjezBB2kNVhgBDzaC18ZkmgC7SDwWi36A6MiU5zx5TDZocc',
    reclaimDeferred: '4vEEoAe6h72XjQ5KHuVF7akaJoVcheWY8VkqDM3SUaHRja84SXF6eCQGhC2Ef1LGYYALyZc7tqivVTUyyYzrge2H',
    deploy: '5Z5ckfDey64X4gMc2cxJA5aXrKrusLGURpAbkyeekuGg7jDDDezFEuyTzZy5wiHGuPXNUoW1bzuhvgkmKE8yzm95',
  },
};

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'tx');

export function fixturePath(dir: keyof typeof FIXTURE_SIGNATURES, signature: string): string {
  return join(FIXTURE_ROOT, dir, `${signature}.json`);
}

async function main() {
  const cacheDir = process.env.INDEXER_TX_CACHE_DIR?.trim() || null;
  const clients = {
    mainnet: new RpcClient({ url: PUBLIC_RPC.mainnet, heavyRps: PUBLIC_RATES.heavy, lightRps: PUBLIC_RATES.light, txCacheDir: cacheDir, log: console.log }),
    devnet: new RpcClient({ url: PUBLIC_RPC.devnet, heavyRps: PUBLIC_RATES.heavy, lightRps: PUBLIC_RATES.light, txCacheDir: cacheDir, log: console.log }),
  };
  let fetched = 0;
  for (const [dir, entries] of Object.entries(FIXTURE_SIGNATURES) as Array<[keyof typeof FIXTURE_SIGNATURES, Record<string, string>]>) {
    mkdirSync(join(FIXTURE_ROOT, dir), { recursive: true });
    const client = dir.startsWith('mainnet') ? clients.mainnet : clients.devnet;
    for (const [name, signature] of Object.entries(entries)) {
      const path = fixturePath(dir, signature);
      if (existsSync(path)) continue;
      const tx = await client.call<unknown>('getTransaction', [
        signature,
        { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
      ]);
      if (!tx) throw new Error(`${dir}/${name}: ${signature} not found`);
      writeFileSync(path, `${JSON.stringify(tx)}\n`);
      fetched += 1;
      console.log(`fetched ${dir}/${name}`);
    }
  }
  console.log(`done: ${fetched} fetched, RPC calls ${JSON.stringify({ mainnet: clients.mainnet.calls, devnet: clients.devnet.calls })}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
