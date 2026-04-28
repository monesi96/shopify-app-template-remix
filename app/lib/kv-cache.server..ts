// app/lib/kv-cache.server.ts
//
// 32 CONCEPT STORE — Cache helper su Vercel KV
// ─────────────────────────────────────────────────────────────────
// Usa Vercel KV per cachare:
//   - Sample 50 prodotti random (refresh ogni 6h)
//   - Risultati ricerche AI (cache per 6h, key = hash query)
//
// Setup Vercel KV:
//   1. Vercel dashboard → progetto magic-ai-agent → Storage
//   2. Create Database → KV → free tier
//   3. Connetti al progetto → Vercel inietta automaticamente
//      KV_URL, KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN
//   4. Installa: npm install @vercel/kv
//
// Se KV non è configurato, le funzioni sotto cadono in modalità "no cache"
// (più lento ma funziona lo stesso).

import type { ShopifyProduct } from "./shopify-catalog.server";

let kvClient: any = null;
let kvAvailable: boolean | null = null;

async function getKV() {
  if (kvAvailable === false) return null;
  if (kvClient) return kvClient;

  try {
    if (
      !process.env.KV_REST_API_URL ||
      !process.env.KV_REST_API_TOKEN
    ) {
      kvAvailable = false;
      console.warn("[kv-cache] Vercel KV not configured, running without cache");
      return null;
    }
    // Import dinamico per non rompere il build se @vercel/kv non è installato
    const mod = await import("@vercel/kv");
    kvClient = mod.kv;
    kvAvailable = true;
    return kvClient;
  } catch (e) {
    console.warn("[kv-cache] @vercel/kv not available:", (e as Error).message);
    kvAvailable = false;
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// GET / SET con TTL
// ═════════════════════════════════════════════════════════════════
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  const kv = await getKV();
  if (!kv) return null;
  try {
    const v = await kv.get(key);
    return v as T | null;
  } catch (e) {
    console.warn("[kv-cache] get error:", (e as Error).message);
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: any,
  ttlSeconds: number
): Promise<void> {
  const kv = await getKV();
  if (!kv) return;
  try {
    await kv.set(key, value, { ex: ttlSeconds });
  } catch (e) {
    console.warn("[kv-cache] set error:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════
// HASH semplice per generare cache keys
// ═════════════════════════════════════════════════════════════════
export function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// ═════════════════════════════════════════════════════════════════
// CACHED random sample — 50 prodotti random, refresh 6h
// ═════════════════════════════════════════════════════════════════
const RANDOM_SAMPLE_KEY = "gf:random-sample:v1";
const RANDOM_SAMPLE_TTL = 60 * 60 * 6; // 6 ore

export async function getCachedRandomSample(
  fetcher: () => Promise<ShopifyProduct[]>
): Promise<ShopifyProduct[]> {
  const cached = await cacheGet<ShopifyProduct[]>(RANDOM_SAMPLE_KEY);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }
  const fresh = await fetcher();
  await cacheSet(RANDOM_SAMPLE_KEY, fresh, RANDOM_SAMPLE_TTL);
  return fresh;
}

// ═════════════════════════════════════════════════════════════════
// CACHED collection picks — top 8 AI per collezione, refresh 6h
// ═════════════════════════════════════════════════════════════════
const COLLECTION_PICKS_TTL = 60 * 60 * 6; // 6 ore

export async function getCachedCollectionPicks<T>(
  collectionHandle: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const key = `gf:collection-picks:${collectionHandle}:v1`;
  const cached = await cacheGet<T>(key);
  if (cached) return cached;
  const fresh = await fetcher();
  await cacheSet(key, fresh, COLLECTION_PICKS_TTL);
  return fresh;
}

// ═════════════════════════════════════════════════════════════════
// CACHED search — cache delle ricerche tool use, 1h
// ═════════════════════════════════════════════════════════════════
const SEARCH_CACHE_TTL = 60 * 60; // 1 ora

export async function getCachedSearch<T>(
  searchKey: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const key = `gf:search:${hashKey(searchKey)}:v1`;
  const cached = await cacheGet<T>(key);
  if (cached) return cached;
  const fresh = await fetcher();
  await cacheSet(key, fresh, SEARCH_CACHE_TTL);
  return fresh;
}
