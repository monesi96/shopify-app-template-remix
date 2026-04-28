// app/lib/shopify-catalog.server.ts
// 32 CONCEPT STORE — Helper Shopify (endpoint PUBBLICI)

const DEFAULT_STORE = "https://32conceptstore.it";

export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  vendor: string;
  productType: string;
  tags: string[];
  price: string;
  compareAtPrice?: string;
  available: boolean;
  imageUrl?: string;
  url: string;
}

function getStoreUrl(): string {
  return (process.env.SHOPIFY_STORE_URL || DEFAULT_STORE).replace(/\/$/, "");
}

function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function mapProduct(raw: any): ShopifyProduct {
  const v0 = raw.variants?.[0] || {};
  const price = v0.price ?? raw.price ?? raw.price_min ?? "0";
  const compareAt = v0.compare_at_price ?? raw.compare_at_price ?? null;
  const image =
    raw.featured_image?.src ||
    raw.featured_image ||
    raw.image?.src ||
    raw.images?.[0]?.src ||
    raw.images?.[0] ||
    "";

  return {
    id: String(raw.id || ""),
    handle: String(raw.handle || ""),
    title: String(raw.title || ""),
    description: stripHtml(raw.body_html || raw.description || "").slice(0, 400),
    vendor: String(raw.vendor || ""),
    productType: String(raw.product_type || ""),
    tags: Array.isArray(raw.tags) ? raw.tags : (raw.tags ? String(raw.tags).split(",").map((t: string) => t.trim()) : []),
    price: parseFloat(String(price)).toFixed(2),
    compareAtPrice: compareAt ? parseFloat(String(compareAt)).toFixed(2) : undefined,
    available: raw.available !== false,
    imageUrl: image ? (image.startsWith("//") ? "https:" + image : image) : undefined,
    url: `/products/${raw.handle}`,
  };
}

export async function searchProducts(opts: {
  query: string;
  limit?: number;
  minPrice?: number;
  maxPrice?: number;
}): Promise<ShopifyProduct[]> {
  const { query, limit = 8, minPrice, maxPrice } = opts;
  if (!query?.trim()) return [];

  const url = `${getStoreUrl()}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${limit}&resources[options][unavailable_products]=hide`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.resources?.results?.products || [];

    let products: ShopifyProduct[] = items.map((p: any) => {
      const priceStr = String(p.price || "0").replace(/[^\d.,]/g, "").replace(",", ".");
      return {
        id: String(p.id || ""),
        handle: String(p.handle || ""),
        title: String(p.title || ""),
        description: stripHtml(p.body || "").slice(0, 400),
        vendor: String(p.vendor || ""),
        productType: String(p.product_type || ""),
        tags: [],
        price: parseFloat(priceStr || "0").toFixed(2),
        available: true,
        imageUrl: p.image ? (p.image.startsWith("//") ? "https:" + p.image : p.image) : undefined,
        url: p.url || `/products/${p.handle}`,
      };
    });

    if (minPrice != null) products = products.filter((p) => parseFloat(p.price) >= minPrice);
    if (maxPrice != null) products = products.filter((p) => parseFloat(p.price) <= maxPrice);
    return products;
  } catch (e) {
    console.error("searchProducts error:", e);
    return [];
  }
}

export async function getCollectionProducts(
  handle: string,
  limit: number = 50
): Promise<{ collection: { title: string; description: string } | null; products: ShopifyProduct[] }> {
  if (!handle) return { collection: null, products: [] };

  const cap = Math.min(limit, 250);
  const url = `${getStoreUrl()}/collections/${encodeURIComponent(handle)}/products.json?limit=${cap}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { collection: null, products: [] };
    const data = await res.json();
    const rawProducts = data?.products || [];
    const products = rawProducts
      .filter((p: any) => p.available !== false)
      .map(mapProduct);

    let collection: { title: string; description: string } | null = null;
    try {
      const collRes = await fetch(`${getStoreUrl()}/collections/${handle}.json`, { headers: { Accept: "application/json" } });
      if (collRes.ok) {
        const collData = await collRes.json();
        if (collData?.collection) {
          collection = {
            title: String(collData.collection.title || handle),
            description: stripHtml(collData.collection.body_html || "").slice(0, 300),
          };
        }
      }
    } catch (e) {}

    if (!collection) collection = { title: handle, description: "" };
    return { collection, products };
  } catch (e) {
    console.error("getCollectionProducts error:", e);
    return { collection: null, products: [] };
  }
}

export async function searchInCollection(
  collectionHandle: string,
  keyword: string = "",
  limit: number = 12,
  minPrice?: number,
  maxPrice?: number
): Promise<ShopifyProduct[]> {
  const { products } = await getCollectionProducts(collectionHandle, 100);
  let filtered = products;

  if (keyword) {
    const k = keyword.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.title.toLowerCase().includes(k) ||
        p.description.toLowerCase().includes(k) ||
        p.vendor.toLowerCase().includes(k) ||
        p.tags.some((t) => t.toLowerCase().includes(k))
    );
  }
  if (minPrice != null) filtered = filtered.filter((p) => parseFloat(p.price) >= minPrice);
  if (maxPrice != null) filtered = filtered.filter((p) => parseFloat(p.price) <= maxPrice);
  return filtered.slice(0, limit);
}

export async function getRandomCatalogSample(count: number = 50): Promise<ShopifyProduct[]> {
  const allProducts: ShopifyProduct[] = [];
  const pagesToFetch = [1, 5, 10];

  for (const page of pagesToFetch) {
    try {
      const url = `${getStoreUrl()}/products.json?limit=250&page=${page}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      const items = data?.products || [];
      const mapped = items.filter((p: any) => p.available !== false).map(mapProduct);
      allProducts.push(...mapped);
      if (items.length < 250) break;
    } catch (e) {}
  }

  for (let i = allProducts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allProducts[i], allProducts[j]] = [allProducts[j], allProducts[i]];
  }
  return allProducts.slice(0, count);
}

export function compressProductForAI(p: ShopifyProduct): string {
  const desc = p.description.slice(0, 100);
  return `[${p.handle}] ${p.title} | ${p.vendor || "—"} | €${p.price}${desc ? ` | ${desc}` : ""}`;
}

export function compressProductsForAI(products: ShopifyProduct[]): string {
  return products.map(compressProductForAI).join("\n");
}
