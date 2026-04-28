// app/routes/api.gift-finder.chat.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  searchProducts,
  searchInCollection,
  getRandomCatalogSample,
  compressProductsForAI,
  type ShopifyProduct,
} from "../lib/shopify-catalog.server";
import {
  getCachedRandomSample,
  getCachedSearch,
} from "../lib/kv-cache.server";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;
const MAX_TOOL_ITERATIONS = 4;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const TOOLS = [
  {
    name: "search_catalog",
    description: "Cerca prodotti nel catalogo di 32 Concept Store usando parole chiave specifiche. Restituisce fino a 8 prodotti con titolo, prezzo, vendor.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Parole chiave specifiche" },
        min_price: { type: "number", description: "Prezzo minimo EUR" },
        max_price: { type: "number", description: "Prezzo massimo EUR" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_collection_products",
    description: "Ottieni prodotti da una collezione Shopify (es. 'penne', 'profumi-candele', 'festa-mamma').",
    input_schema: {
      type: "object",
      properties: {
        collection_handle: { type: "string", description: "Handle collezione" },
        min_price: { type: "number" },
        max_price: { type: "number" },
        keyword: { type: "string", description: "Filtro keyword opzionale" },
      },
      required: ["collection_handle"],
    },
  },
];

function buildSystemPrompt(inspirationProducts: ShopifyProduct[]): string {
  const inspirationStr = compressProductsForAI(inspirationProducts.slice(0, 50));
  const parts: string[] = [];
  parts.push("Sei il personal shopper AI di 32 Concept Store, negozio italiano (Bari) di design e regali.");
  parts.push("");
  parts.push("# Tono: caldo, italiano, frasi brevi (max 3-4), emoji con parsimonia.");
  parts.push("");
  parts.push("# Come rispondi:");
  parts.push("1. Se mancano info essenziali (destinatario/occasione/budget) fai UNA domanda alla volta.");
  parts.push("2. Quando hai abbastanza info, USA SUBITO i tool. NON inventare prodotti.");
  parts.push("3. Dopo aver cercato, scegli 3-4 prodotti adatti motivandoli.");
  parts.push("");
  parts.push("# Tool:");
  parts.push("- search_catalog(query, min_price?, max_price?) per parole chiave");
  parts.push("- get_collection_products(collection_handle, min_price?, max_price?, keyword?) per collezioni");
  parts.push("");
  parts.push("# Strategia:");
  parts.push("- Per OCCASIONE (laurea, festa mamma) usa get_collection_products");
  parts.push("- Per CARATTERISTICA (romantico, da scrivania) usa search_catalog");
  parts.push("");
  parts.push("# Collezioni disponibili (handle):");
  parts.push("festa-mamma, festa-papa, compleanno, laurea, anniversario-matrimonio, idee-regalo-nascita, penne, matite-accessori-scrivania, quaderni-agende-planner, borse-e-zaini, portafogli-beauty-accessori, trolley-borse-viaggio, lampade-e-luci, tazze-piatti-bicchieri, decorazioni-piante, cornici-portafoto, profumi-candele, speaker-cuffie, sveglie-orologi-smart, lampade-smart, paperelle-collezione, peluche-pupazzi, giochi-creativi-tavolo, t-shirt-felpe, abbigliamento-bambini, natale");
  parts.push("");
  parts.push("# Brand: Legami, EDG, Egan, Lamy, Seletti, Moulin Roty, Yankee Candle, 24Bottles, Moleskine, Ichendorf, Kikkerland, Goofi, Piattini d'Avanguardia.");
  parts.push("");
  parts.push("# Ispirazione (50 prodotti random dal catalogo):");
  parts.push(inspirationStr);
  parts.push("");
  parts.push("# Formato risposta:");
  parts.push("Quando hai i prodotti, referenzia con [handle-prodotto] tra parentesi quadre.");
  parts.push("Esempio: 'Per la mamma: [candela-fiori] candela 28€, [tazza-rosa] tazza Legami. Vuoi vederne altre?'");
  parts.push("I tag [handle] diventano card cliccabili. SOLO handle trovati tramite tool. MAI inventare.");
  parts.push("Concludi sempre con UNA opzione per continuare.");
  return parts.join("\n");
}

async function executeTool(name: string, input: any): Promise<{ products: ShopifyProduct[]; summary: string }> {
  try {
    if (name === "search_catalog") {
      const query = String(input.query || "").trim();
      if (!query) return { products: [], summary: "Query vuota." };
      const cacheKey = "search:" + query + ":" + (input.min_price || "") + ":" + (input.max_price || "");
      const products = await getCachedSearch(cacheKey, () =>
        searchProducts({ query, minPrice: input.min_price, maxPrice: input.max_price, limit: 8 })
      );
      if (products.length === 0) return { products: [], summary: "Nessun prodotto per: " + query };
      return { products, summary: "Trovati " + products.length + " prodotti per " + query + ":\n" + compressProductsForAI(products) };
    }

    if (name === "get_collection_products") {
      const handle = String(input.collection_handle || "").trim();
      if (!handle) return { products: [], summary: "Handle vuoto." };
      const cacheKey = "coll:" + handle + ":" + (input.keyword || "") + ":" + (input.min_price || "") + ":" + (input.max_price || "");
      const products = await getCachedSearch(cacheKey, () =>
        searchInCollection(handle, input.keyword || "", 12, input.min_price, input.max_price)
      );
      if (products.length === 0) return { products: [], summary: "Collezione vuota: " + handle };
      return { products, summary: "Trovati " + products.length + " prodotti dalla collezione " + handle + ":\n" + compressProductsForAI(products) };
    }
    return { products: [], summary: "Unknown tool: " + name };
  } catch (e: any) {
    console.error("Tool error:", name, e);
    return { products: [], summary: "Tool error: " + (e?.message || "unknown") };
  }
}

function extractHandlesFromMessage(text: string): string[] {
  const matches = text.match(/\[([a-z0-9-]+)\]/gi) || [];
  return matches.map((m) => m.slice(1, -1)).filter((h) => h.length > 2);
}

export async function loader() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY missing" }, { status: 500, headers: CORS_HEADERS });

  let body: any;
  try { body = await request.json(); } catch (e) {
    return json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }

  const history: Array<{ role: string; content: string }> = body.history || [];
  if (!Array.isArray(history) || history.length === 0) {
    return json({ error: "Missing history" }, { status: 400, headers: CORS_HEADERS });
  }

  let inspiration: ShopifyProduct[] = [];
  try {
    inspiration = await getCachedRandomSample(() => getRandomCatalogSample(50));
  } catch (e) {
    console.warn("inspiration error:", (e as Error).message);
  }

  const systemPrompt = buildSystemPrompt(inspiration);

  let messages: any[] = history
    .slice(-12)
    .filter((m) => m && m.role && m.content)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, 2000),
    }));

  const productMap = new Map<string, ShopifyProduct>();
  let finalText = "";
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, tools: TOOLS, messages }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("=== ANTHROPIC ERROR ===", anthropicRes.status, errText);
      return json({ error: "AI service error: " + anthropicRes.status }, { status: 502, headers: CORS_HEADERS });
    }

    const data = await anthropicRes.json();
    const stopReason = data.stop_reason;
    const content = data.content || [];
    const toolUses = content.filter((b: any) => b.type === "tool_use");
    const textBlocks = content.filter((b: any) => b.type === "text");
    const accumulatedText = textBlocks.map((b: any) => b.text).join("\n").trim();

    if (stopReason === "tool_use" && toolUses.length > 0) {
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await executeTool(tu.name, tu.input);
        for (const p of result.products) productMap.set(p.handle, p);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result.summary });
      }
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    finalText = accumulatedText;
    break;
  }

  if (!finalText) finalText = "Mi dispiace, riprova tra un attimo.";

  const handles = extractHandlesFromMessage(finalText);
  const finalProducts = handles
    .map((h) => productMap.get(h))
    .filter((p): p is ShopifyProduct => !!p);

  const lastUser = history.filter((m) => m.role === "user").pop()?.content?.toLowerCase() || "";
  const sugg: string[] = [];
  if (!/\d+\s*€|euro/.test(lastUser)) { sugg.push("Sotto 30€"); sugg.push("Tra 30 e 80€"); }
  if (finalText.length < 200) sugg.push("Voglio vederne altri");
  sugg.push("Cambia stile");

  return json({
    message: finalText,
    products: finalProducts.map((p) => ({
      handle: p.handle,
      title: p.title,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      image: p.imageUrl,
      url: p.url,
      vendor: p.vendor,
    })),
    suggestions: sugg.slice(0, 4),
  }, { headers: CORS_HEADERS });
}
