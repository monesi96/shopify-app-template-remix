// app/routes/api.gift-finder.collection-picks.tsx
// 32 CONCEPT STORE — Top Picks AI per Collezione

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  getCollectionProducts,
  type ShopifyProduct,
} from "../lib/shopify-catalog.server";
import { getCachedCollectionPicks } from "../lib/kv-cache.server";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

interface AIPick {
  handle: string;
  reason: string;
}

async function pickTopProducts(
  collectionTitle: string,
  collectionDesc: string,
  products: ShopifyProduct[]
): Promise<AIPick[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  if (products.length <= 6) {
    return products.map((p) => ({ handle: p.handle, reason: "" }));
  }

  const productList = products
    .slice(0, 50)
    .map((p, i) =>
      `${i + 1}. [${p.handle}] ${p.title} | ${p.vendor || "—"} | €${p.price}${
        p.description ? " | " + p.description.slice(0, 100) : ""
      }`
    )
    .join("\n");

  const systemPrompt = `Sei un curatore esperto di regali per 32 Concept Store, negozio italiano di design e idee regalo.

Ti viene data una lista di prodotti di una collezione. Devi scegliere i **6-8 migliori** considera
cat > app/routes/api.gift-finder.collection-picks.tsx << 'CLAUDEEOF'
// app/routes/api.gift-finder.collection-picks.tsx
// 32 CONCEPT STORE — Top Picks AI per Collezione

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  getCollectionProducts,
  type ShopifyProduct,
} from "../lib/shopify-catalog.server";
import { getCachedCollectionPicks } from "../lib/kv-cache.server";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

interface AIPick {
  handle: string;
  reason: string;
}

async function pickTopProducts(
  collectionTitle: string,
  collectionDesc: string,
  products: ShopifyProduct[]
): Promise<AIPick[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  if (products.length <= 6) {
    return products.map((p) => ({ handle: p.handle, reason: "" }));
  }

  const productList = products
    .slice(0, 50)
    .map((p, i) =>
      `${i + 1}. [${p.handle}] ${p.title} | ${p.vendor || "—"} | €${p.price}${
        p.description ? " | " + p.description.slice(0, 100) : ""
      }`
    )
    .join("\n");

  const systemPrompt = `Sei un curatore esperto di regali per 32 Concept Store, negozio italiano di design e idee regalo.

Ti viene data una lista di prodotti di una collezione. Devi scegliere i **6-8 migliori** considerando:
- Varietà di prezzo
- Varietà di stile (non 6 candele identiche)
- Probabilità che siano apprezzati come regalo
- Attrattiva visiva e descrittiva del titolo

Per ogni prodotto scelto, scrivi un motivo BREVE (max 12 parole) e accattivante in italiano.

Rispondi SOLO con JSON valido:
\`\`\`json
{
  "picks": [
    { "handle": "candela-vaniglia", "reason": "Profumo caldo, ideale per il salotto" }
  ]
}
\`\`\`

Includi SOLO handle che esistono nella lista. Massimo 8, minimo 6.`;

  const userPrompt = `Collezione: **${collectionTitle}**${
    collectionDesc ? "\nDescrizione: " + collectionDesc.slice(0, 200) : ""
  }

Prodotti disponibili (${products.length}):
${productList}

Scegli i 6-8 migliori per regalo.`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI error ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";

  const fence = text.match(/\`\`\`(?:json)?\s*\n?([\s\S]*?)\n?\`\`\`/);
  const jsonStr = fence ? fence[1] : text;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch (e) {
    const m = jsonStr.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (_) { return []; }
    } else return [];
  }

  if (!Array.isArray(parsed.picks)) return [];

  const validHandles = new Set(products.map((p) => p.handle));
  return parsed.picks
    .filter((p: any) => p && p.handle && validHandles.has(p.handle))
    .map((p: any) => ({
      handle: String(p.handle),
      reason: String(p.reason || "").slice(0, 200),
    }))
    .slice(0, 8);
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const handle = url.searchParams.get("handle")?.trim();
  if (!handle) {
    return json({ error: "Missing 'handle' query param" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const result = await getCachedCollectionPicks(handle, async () => {
      const { collection, products } = await getCollectionProducts(handle, 50);
      if (!collection || products.length === 0) {
        return { collection: null, picks: [] };
      }

      const aiPicks = await pickTopProducts(
        collection.title,
        collection.description || "",
        products
      );

      const productByHandle = new Map(products.map((p) => [p.handle, p]));
      const picks = aiPicks
        .map((ap) => {
          const p = productByHandle.get(ap.handle);
          if (!p) return null;
          return {
            handle: p.handle,
            title: p.title,
            price: p.price,
            compareAtPrice: p.compareAtPrice,
            image: p.imageUrl,
            url: p.url,
            vendor: p.vendor,
            reason: ap.reason,
          };
        })
        .filter(Boolean);

      return {
        collection: { title: collection.title, description: collection.description },
        picks,
      };
    });

    return json(result, {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=300, s-maxage=21600",
      },
    });
  } catch (e: any) {
    console.error("collection-picks error:", e);
    return json({ error: e?.message || "Internal error" }, { status: 500, headers: CORS_HEADERS });
  }
}
