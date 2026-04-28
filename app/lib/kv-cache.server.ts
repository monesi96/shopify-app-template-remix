// app/lib/kv-cache.server.ts
// 32 CONCEPT STORE — Cache helper Vercel KV

import type { ShopifyProduct } from "./shopify-catalog.server";

let kvClient: any = null;
let kvAvailable: boolean | null = null;

async function getKV() {
  if (kvAvailable === false) return null;
  if (kvClient) return kvClient;

  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      kvAvailable = false;
      console.warn("[kv-cache] Vercel KV not configured");
      return null;
    }
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

export async function cacheGet<T = any>(key: string): Promise<T | null> {
  const kv = await getKV();
  if (!kv) return null;
  try {
    const v = await kv.get(key);
    return v as T | null;
  } catch (e) {
    return null;
  }
}

export async function cacheSet(key: string, value: any, ttlSeconds: number): Promise<void> {
  const kv = await getKV();
  if (!kv) return;
  try {
    await kv.set(key, value, { ex: ttlSeconds });
  } catch (e) {}
}

export function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

const RANDOM_SAMPLE_KEY = "gf:random-sample:v1";
const RANDOM_SAMPLE_TTL = 60 * 60 * 6;

export async function getCachedRandomSample(
  fetcher: () => Promise<ShopifyProduct[]>
): Promise<ShopifyProduct[]> {
  const cached = await cacheGet<ShopifyProduct[]>(RANDOM_SAMPLE_KEY);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;
  const fresh = await fetcher();
  await cacheSet(RANDOM_SAMPLE_KEY, fresh, RANDOM_SAMPLE_TTL);
  return fresh;
}

const COLLECTION_PICKS_TTL = 60 * 60 * 6;

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

const SEARCH_CACHE_TTL = 60 * 60;

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
