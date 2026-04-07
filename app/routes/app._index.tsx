import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Select,
  TextField,
  Badge,
  Banner,
  Box,
  IndexTable,
  useIndexResourceState,
  Thumbnail,
  EmptyState,
  Tabs,
  RangeSlider,
  Checkbox,
  Divider,
  ProgressBar,
  Modal,
  Collapsible,
  Icon,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// ── LOADER: Carica prodotti con più dati ─────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    query getProducts {
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            tags
            descriptionHtml
            featuredMedia {
              preview {
                image {
                  url
                  altText
                }
              }
            }
            variants(first: 5) {
              edges {
                node {
                  price
                  barcode
                  sku
                  title
                }
              }
            }
            media(first: 5) {
              edges {
                node {
                  mediaContentType
                  preview {
                    image {
                      url
                      altText
                      width
                      height
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`
  );

  const responseJson = await response.json();
  const products = responseJson.data.products.edges.map((edge: any) => ({
    id: edge.node.id,
    numericId: edge.node.id.replace("gid://shopify/Product/", ""),
    title: edge.node.title,
    handle: edge.node.handle,
    vendor: edge.node.vendor,
    productType: edge.node.productType,
    tags: edge.node.tags || [],
    description: edge.node.descriptionHtml || "",
    image: edge.node.featuredMedia?.preview?.image?.url || "",
    imageWidth: edge.node.featuredMedia?.preview?.image?.width || 0,
    imageHeight: edge.node.featuredMedia?.preview?.image?.height || 0,
    price: edge.node.variants.edges[0]?.node?.price || "0.00",
    barcode: edge.node.variants.edges[0]?.node?.barcode || "",
    sku: edge.node.variants.edges[0]?.node?.sku || "",
    variantTitle: edge.node.variants.edges[0]?.node?.title || "",
    variants: edge.node.variants.edges.map((v: any) => ({
      price: v.node.price,
      barcode: v.node.barcode,
      sku: v.node.sku,
      title: v.node.title,
    })),
    images: edge.node.media.edges
      .filter((m: any) => m.node.preview?.image?.url)
      .map((m: any) => ({
        url: m.node.preview.image.url,
        alt: m.node.preview.image.altText,
        width: m.node.preview.image.width,
        height: m.node.preview.image.height,
      })),
  }));

  return json({ products });
};

// ── ACTION: Genera / Pusha / Ricerca EAN ─────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── GENERA DESCRIZIONE CON CLAUDE ──
  if (intent === "generate") {
    const productsJSON = formData.get("products") as string;
    const tone = formData.get("tone") as string;
    const framework = formData.get("framework") as string;
    const language = formData.get("language") as string;
    const keywords = formData.get("keywords") as string;
    const length = formData.get("length") as string;
    const structure = formData.get("structure") as string;
    const useImage = formData.get("useImage") as string;
    const useBarcode = formData.get("useBarcode") as string;
    const products = JSON.parse(productsJSON);

    const results: any[] = [];

    for (const product of products) {
      // Se useBarcode è attivo e c'è un barcode, cerca info online
      let barcodeInfo = "";
      if (useBarcode === "true" && product.barcode) {
        try {
          const searchResp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.ANTHROPIC_API_KEY || "",
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 300,
              messages: [{
                role: "user",
                content: `Cerca informazioni sul prodotto con codice EAN/barcode: ${product.barcode}. Il prodotto si chiama "${product.title}" del brand "${product.vendor}". Dammi una breve scheda tecnica con caratteristiche principali, materiali, dimensioni se disponibili. Rispondi SOLO con le info trovate, senza prefissi.`
              }],
            }),
          });
          const searchData = await searchResp.json();
          barcodeInfo = searchData.content?.[0]?.text?.trim() || "";
        } catch (e) {
          barcodeInfo = "";
        }
      }

      // Costruisci info immagine
      let imageContext = "";
      if (useImage === "true" && product.image) {
        imageContext = `\n- Immagine prodotto disponibile: ${product.image}`;
        if (product.images && product.images.length > 1) {
          imageContext += `\n- Numero foto disponibili: ${product.images.length}`;
        }
      }

      const prompt = buildPrompt(product, tone, framework, language, keywords, length, structure, barcodeInfo, imageContext);

      try {
        const messages: any[] = [];

        // Se useImage è attivo, invia anche l'immagine a Claude
        if (useImage === "true" && product.image) {
          try {
            const imgResp = await fetch(product.image);
            const imgBuffer = await imgResp.arrayBuffer();
            const base64 = Buffer.from(imgBuffer).toString("base64");
            const contentType = imgResp.headers.get("content-type") || "image/jpeg";

            messages.push({
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: contentType.split(";")[0],
                    data: base64,
                  },
                },
                { type: "text", text: prompt },
              ],
            });
          } catch (imgErr) {
            // Fallback: solo testo
            messages.push({ role: "user", content: prompt });
          }
        } else {
          messages.push({ role: "user", content: prompt });
        }

        const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY || "",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: length === "long" ? 1200 : length === "medium" ? 700 : 400,
            messages,
          }),
        });

        const aiData = await aiResponse.json();
        let newDescription = aiData.content?.[0]?.text?.trim() || "";

        // Pulisci backtick markdown se presenti
        newDescription = newDescription
          .replace(/^```html\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        results.push({
          id: product.id,
          title: product.title,
          image: product.image,
          vendor: product.vendor,
          price: product.price,
          newDescription,
          status: newDescription ? "success" : "error",
        });
      } catch (error: any) {
        results.push({
          id: product.id,
          title: product.title,
          image: product.image,
          vendor: product.vendor,
          price: product.price,
          newDescription: "",
          status: "error",
          error: error.message,
        });
      }
    }

    return json({ intent: "generate", results });
  }

  // ── PUSHA DESCRIZIONE SU SHOPIFY ──
  if (intent === "push") {
    const productId = formData.get("productId") as string;
    const description = formData.get("description") as string;
    const mode = formData.get("mode") as string || "replace";

    let finalDescription = description;

    if (mode === "append") {
      // Recupera descrizione esistente
      const getResp = await admin.graphql(
        `#graphql
        query getProduct($id: ID!) {
          product(id: $id) {
            descriptionHtml
          }
        }`,
        { variables: { id: productId } }
      );
      const getData = await getResp.json();
      const existing = getData.data?.product?.descriptionHtml || "";
      if (existing.trim()) {
        finalDescription = existing.trimEnd() +
          '\n<hr style="border:none;border-top:1px solid #e8e8e4;margin:24px 0;">\n' +
          description;
      }
    }

    const response = await admin.graphql(
      `#graphql
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            descriptionHtml
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            id: productId,
            descriptionHtml: finalDescription,
          },
        },
      }
    );

    const responseJson = await response.json();
    const errors = responseJson.data?.productUpdate?.userErrors || [];

    if (errors.length > 0) {
      return json({ intent: "push", success: false, error: errors[0].message });
    }

    return json({ intent: "push", success: true, productId });
  }

  // ── PUSH MULTIPLO ──
  if (intent === "pushAll") {
    const resultsJSON = formData.get("results") as string;
    const mode = formData.get("mode") as string || "replace";
    const results = JSON.parse(resultsJSON);
    let pushed = 0;
    let errors = 0;

    for (const result of results) {
      if (result.status !== "success") continue;

      let finalDescription = result.newDescription;

      if (mode === "append") {
        const getResp = await admin.graphql(
          `#graphql
          query getProduct($id: ID!) {
            product(id: $id) {
              descriptionHtml
            }
          }`,
          { variables: { id: result.id } }
        );
        const getData = await getResp.json();
        const existing = getData.data?.product?.descriptionHtml || "";
        if (existing.trim()) {
          finalDescription = existing.trimEnd() +
            '\n<hr style="border:none;border-top:1px solid #e8e8e4;margin:24px 0;">\n' +
            result.newDescription;
        }
      }

      try {
        const response = await admin.graphql(
          `#graphql
          mutation updateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id }
              userErrors { field message }
            }
          }`,
          { variables: { input: { id: result.id, descriptionHtml: finalDescription } } }
        );
        const rJson = await response.json();
        if ((rJson.data?.productUpdate?.userErrors || []).length === 0) {
          pushed++;
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }

    return json({ intent: "pushAll", pushed, errors });
  }

  return json({ error: "Intent non valido" });
};

// ── PROMPT BUILDER V2 ────────────────────────────────────────
function buildPrompt(
  product: any,
  tone: string,
  framework: string,
  language: string,
  keywords: string,
  length: string,
  structure: string,
  barcodeInfo: string,
  imageContext: string
) {
  const toneMap: Record<string, string> = {
    professional: "Professionale e autorevole — comunica competenza e affidabilità",
    emotional: "Emozionale e coinvolgente — fai sentire il lettore parte di un'esperienza",
    technical: "Tecnico e dettagliato — focus su specifiche, materiali, performance",
    luxury: "Luxury ed esclusivo — linguaggio raffinato, evocativo, aspirazionale",
    casual: "Casual e amichevole — come un amico che ti consiglia il prodotto",
    ironic: "Ironico e originale — smart, con personalità, memorabile",
    minimal: "Minimal e pulito — essenziale, ogni parola conta, zero fuffa",
  };

  const frameworkMap: Record<string, string> = {
    aida: "AIDA: Apri con un hook che cattura l'ATTENZIONE → crea INTERESSE con dettagli unici → genera DESIDERIO con benefici emotivi → chiudi con AZIONE (CTA)",
    pas: "PAS: Identifica un PROBLEMA del target → AGITA mostrando le conseguenze → presenta il prodotto come SOLUZIONE",
    fab: "FAB: Descrivi la FEATURE tecnica → spiega il VANTAGGIO concreto → collega al BENEFICIO emotivo per l'utente",
    storytelling: "STORYTELLING: Racconta una mini-storia o scenario d'uso che coinvolge il lettore e lo fa immedesimare",
    direct: "DIRETTO: Vai dritto ai benefici principali senza giri di parole, perfetto per chi cerca info rapide",
    comparison: "CONFRONTO: Posiziona il prodotto rispetto ad alternative, evidenziando cosa lo rende unico",
  };

  const langMap: Record<string, string> = {
    it: "italiano",
    en: "inglese",
    fr: "francese",
    de: "tedesco",
    es: "spagnolo",
  };

  const lengthMap: Record<string, string> = {
    short: "BREVE: 50-80 parole, 2-3 frasi. Perfetta per card prodotto e listing veloci",
    medium: "MEDIA: 100-150 parole, 3-5 frasi con bullet point. Bilanciata per la maggior parte degli e-commerce",
    long: "LUNGA: 200-350 parole, descrizione completa con paragrafi strutturati, H3, bullet point, dettagli tecnici e CTA. Ideale per SEO e pagine prodotto complete",
  };

  const structureMap: Record<string, string> = {
    simple: "Testo semplice con paragrafi <p>",
    structured: "Struttura con <h3> per sezioni principali, <p> per testo, <ul><li> per bullet point",
    rich: "Struttura ricca: <h3> titolo sezione + <p> intro + <h4> sottosezioni + <ul><li> specifiche + <p><strong>CTA</strong></p> finale",
    seo_optimized: "SEO-ottimizzata: <h3> con keyword primaria + <p> intro con keyword + <h4> sottosezioni + <ul><li> benefici con keyword secondarie + <p> CTA + struttura che facilita i featured snippet di Google",
  };

  const hasDesc = product.description && product.description.length > 20;
  const cleanDesc = hasDesc
    ? product.description.replace(/<[^>]+>/g, "").substring(0, 600)
    : "";

  const variantsInfo = product.variants && product.variants.length > 1
    ? `\n- Varianti disponibili: ${product.variants.map((v: any) => v.title).filter((t: string) => t !== "Default Title").join(", ")}`
    : "";

  const tagsInfo = product.tags && product.tags.length > 0
    ? `\n- Tag: ${product.tags.join(", ")}`
    : "";

  return `Sei un copywriter e-commerce senior specializzato in SEO e conversion rate optimization.

PRODOTTO:
- Titolo: ${product.title}
- Brand: ${product.vendor || "non specificato"}
- Categoria: ${product.productType || "non specificata"}
- Prezzo: €${product.price}
- SKU: ${product.sku || "N/A"}
- EAN/Barcode: ${product.barcode || "N/A"}${variantsInfo}${tagsInfo}${imageContext}
${cleanDesc ? `- Descrizione attuale: ${cleanDesc}` : ""}
${barcodeInfo ? `\nINFO AGGIUNTIVE DAL BARCODE:\n${barcodeInfo}` : ""}

CONFIGURAZIONE:
- Framework: ${frameworkMap[framework] || framework}
- Tono: ${toneMap[tone] || tone}
- Lingua: ${langMap[language] || language}
- Lunghezza: ${lengthMap[length] || length}
- Struttura HTML: ${structureMap[structure] || structure}
${keywords ? `- Keyword SEO (includi naturalmente): ${keywords}` : ""}

${product.image ? "NOTA: Ti ho fornito anche l'immagine del prodotto. Usa i dettagli visivi (colore, materiale, design, forma) per arricchire la descrizione." : ""}

REGOLE ASSOLUTE:
1. Scrivi SOLO codice HTML valido — niente markdown, niente backtick, niente prefissi
2. NON iniziare con "Questo prodotto" o "Il/La [nome prodotto]"
3. NON usare frasi generiche: "alta qualità", "il migliore", "unico nel suo genere"
4. OGNI frase deve aggiungere valore informativo o emotivo
5. I bullet point devono contenere benefici CONCRETI e SPECIFICI
6. La CTA finale deve essere naturale, non aggressiva
7. Se la struttura richiede H3/H4, usa titoli creativi e SEO-friendly, MAI generici come "Caratteristiche" o "Descrizione"
8. Includi il prezzo nella CTA solo se appropriato per il tono scelto

Scrivi la descrizione HTML ora:`;
}

// ── COMPONENTE PRINCIPALE V2 ─────────────────────────────────
export default function Index() {
  const { products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // Stato impostazioni
  const [tone, setTone] = useState("emotional");
  const [framework, setFramework] = useState("aida");
  const [language, setLanguage] = useState("it");
  const [keywords, setKeywords] = useState("");
  const [length, setLength] = useState("medium");
  const [structure, setStructure] = useState("structured");
  const [useImage, setUseImage] = useState(true);
  const [useBarcode, setUseBarcode] = useState(true);
  const [pushMode, setPushMode] = useState("replace");
  const [generatedResults, setGeneratedResults] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [expandedResult, setExpandedResult] = useState<string | null>(null);

  // Selezione prodotti
  const resourceIDResolver = (product: any) => product.id;
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(products, { resourceIDResolver });

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isPushing =
    fetcher.state !== "idle" &&
    (fetcher.formData?.get("intent") === "push" || fetcher.formData?.get("intent") === "pushAll");

  // Aggiorna risultati
  if (fetcher.data?.intent === "generate" && fetcher.data?.results) {
    if (JSON.stringify(generatedResults) !== JSON.stringify(fetcher.data.results)) {
      setTimeout(() => setGeneratedResults(fetcher.data.results), 0);
    }
  }

  // Notifica push completato
  if (fetcher.data?.intent === "pushAll" && fetcher.data?.pushed !== undefined) {
    // Toast gestito da Shopify
  }

  // ── HANDLERS ──
  const handleGenerate = useCallback(() => {
    const selected = products.filter((p: any) => selectedResources.includes(p.id));
    if (selected.length === 0) return;

    const formData = new FormData();
    formData.append("intent", "generate");
    formData.append("products", JSON.stringify(selected));
    formData.append("tone", tone);
    formData.append("framework", framework);
    formData.append("language", language);
    formData.append("keywords", keywords);
    formData.append("length", length);
    formData.append("structure", structure);
    formData.append("useImage", useImage.toString());
    formData.append("useBarcode", useBarcode.toString());
    fetcher.submit(formData, { method: "POST" });
  }, [selectedResources, products, tone, framework, language, keywords, length, structure, useImage, useBarcode, fetcher]);

  const handlePush = useCallback((productId: string, description: string) => {
    const formData = new FormData();
    formData.append("intent", "push");
    formData.append("productId", productId);
    formData.append("description", description);
    formData.append("mode", pushMode);
    fetcher.submit(formData, { method: "POST" });
  }, [fetcher, pushMode]);

  const handlePushAll = useCallback(() => {
    const successResults = generatedResults.filter((r: any) => r.status === "success");
    if (successResults.length === 0) return;
    const formData = new FormData();
    formData.append("intent", "pushAll");
    formData.append("results", JSON.stringify(successResults));
    formData.append("mode", pushMode);
    fetcher.submit(formData, { method: "POST" });
  }, [generatedResults, fetcher, pushMode]);

  // ── SELECT OPTIONS ──
  const toneOptions = [
    { label: "🎭 Emozionale", value: "emotional" },
    { label: "💼 Professionale", value: "professional" },
    { label: "🔧 Tecnico", value: "technical" },
    { label: "✨ Luxury", value: "luxury" },
    { label: "😎 Casual", value: "casual" },
    { label: "😏 Ironico", value: "ironic" },
    { label: "🎯 Minimal", value: "minimal" },
  ];

  const frameworkOptions = [
    { label: "AIDA — Attenzione → Azione", value: "aida" },
    { label: "PAS — Problema → Soluzione", value: "pas" },
    { label: "FAB — Feature → Benefit", value: "fab" },
    { label: "📖 Storytelling", value: "storytelling" },
    { label: "🎯 Diretto", value: "direct" },
    { label: "⚖️ Confronto", value: "comparison" },
  ];

  const languageOptions = [
    { label: "🇮🇹 Italiano", value: "it" },
    { label: "🇬🇧 English", value: "en" },
    { label: "🇫🇷 Français", value: "fr" },
    { label: "🇩🇪 Deutsch", value: "de" },
    { label: "🇪🇸 Español", value: "es" },
  ];

  const lengthOptions = [
    { label: "📝 Breve (50-80 parole)", value: "short" },
    { label: "📄 Media (100-150 parole)", value: "medium" },
    { label: "📋 Lunga (200-350 parole)", value: "long" },
  ];

  const structureOptions = [
    { label: "Semplice (solo paragrafi)", value: "simple" },
    { label: "Strutturata (H3 + bullet)", value: "structured" },
    { label: "Ricca (H3 + H4 + bullet + CTA)", value: "rich" },
    { label: "🔍 SEO-ottimizzata (snippet-ready)", value: "seo_optimized" },
  ];

  const pushModeOptions = [
    { label: "🔄 Sostituisci descrizione", value: "replace" },
    { label: "➕ Aggiungi sotto l'esistente", value: "append" },
  ];

  const tabs = [
    { id: "settings", content: "⚙️ Impostazioni", panelID: "settings-panel" },
    { id: "products", content: "📦 Prodotti (" + products.length + ")", panelID: "products-panel" },
    { id: "results", content: "✍️ Risultati" + (generatedResults.length > 0 ? " (" + generatedResults.length + ")" : ""), panelID: "results-panel" },
  ];

  const successCount = generatedResults.filter((r: any) => r.status === "success").length;

  // ── ROW MARKUP ──
  const rowMarkup = products.map((product: any, index: number) => {
    const result = generatedResults.find((r: any) => r.id === product.id);
    return (
      <IndexTable.Row
        id={product.id}
        key={product.id}
        selected={selectedResources.includes(product.id)}
        position={index}
      >
        <IndexTable.Cell>
          <Thumbnail
            source={product.image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png"}
            alt={product.title}
            size="small"
          />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="100">
            <Text variant="bodyMd" fontWeight="bold" as="span">{product.title}</Text>
            {product.barcode && (
              <Text variant="bodySm" as="span" tone="subdued">EAN: {product.barcode}</Text>
            )}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>{product.vendor}</IndexTable.Cell>
        <IndexTable.Cell>€{product.price}</IndexTable.Cell>
        <IndexTable.Cell>
          {product.images?.length || 0} foto
        </IndexTable.Cell>
        <IndexTable.Cell>
          {result ? (
            result.status === "success" ? (
              <Badge tone="success">Generata</Badge>
            ) : (
              <Badge tone="critical">Errore</Badge>
            )
          ) : (
            <Badge>In attesa</Badge>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {result?.status === "success" && (
            <Button size="slim" onClick={() => handlePush(product.id, result.newDescription)} loading={isPushing}>
              Pubblica
            </Button>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  // ── RENDER ──
  return (
    <Page>
      <TitleBar title="AI Product Description Generator" />
      <BlockStack gap="500">

        {/* HEADER CON STATS */}
        <InlineStack gap="400" wrap={true}>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Prodotti</Text>
              <Text as="p" variant="headingLg">{products.length}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Selezionati</Text>
              <Text as="p" variant="headingLg">{selectedResources.length}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Generati</Text>
              <Text as="p" variant="headingLg">{successCount}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Costo stimato</Text>
              <Text as="p" variant="headingLg">~€{(selectedResources.length * (length === "long" ? 0.008 : length === "medium" ? 0.005 : 0.003)).toFixed(3)}</Text>
            </BlockStack>
          </Card>
        </InlineStack>

        {/* TABS */}
        <Card>
          <Tabs tabs={tabs} selected={activeTab} onSelect={setActiveTab}>
            {/* TAB IMPOSTAZIONI */}
            {activeTab === 0 && (
              <Box padding="400">
                <BlockStack gap="500">
                  {/* Riga 1: Tono + Framework + Lingua */}
                  <InlineStack gap="400" wrap={true}>
                    <div style={{ minWidth: "200px", flex: 1 }}>
                      <Select label="Tono di voce" options={toneOptions} value={tone} onChange={setTone} />
                    </div>
                    <div style={{ minWidth: "200px", flex: 1 }}>
                      <Select label="Framework copy" options={frameworkOptions} value={framework} onChange={setFramework} />
                    </div>
                    <div style={{ minWidth: "200px", flex: 1 }}>
                      <Select label="Lingua" options={languageOptions} value={language} onChange={setLanguage} />
                    </div>
                  </InlineStack>

                  {/* Riga 2: Lunghezza + Struttura + Push mode */}
                  <InlineStack gap="400" wrap={true}>
                    <div style={{ minWidth: "200px", flex: 1 }}>
                      <Select label="Lunghezza descrizione" options={lengthOptions} value={length} onChange={setLength} />
                    </div>
                    <div style={{ minWidth: "200px", flex: 1 }}>
                      <Select label="Struttura HTML" options={structureOptions} value={structure} onChange={setStructure} />
                    </div>
                    <div style={{ minWidth: "200px", flex: 1 }}>
                      <Select label="Modalità pubblicazione" options={pushModeOptions} value={pushMode} onChange={setPushMode} />
                    </div>
                  </InlineStack>

                  {/* Keyword SEO */}
                  <TextField
                    label="Keyword SEO (opzionale)"
                    value={keywords}
                    onChange={setKeywords}
                    placeholder="es: scarpe running, sneakers uomo, regalo sportivo"
                    autoComplete="off"
                    helpText="Separa le keyword con virgola. Verranno incluse naturalmente nel testo."
                  />

                  {/* Opzioni avanzate */}
                  <Divider />
                  <Text as="h3" variant="headingMd">🔬 Fonti dati per la generazione</Text>
                  <InlineStack gap="600">
                    <Checkbox
                      label="📸 Analizza immagine prodotto (Claude Vision)"
                      checked={useImage}
                      onChange={setUseImage}
                      helpText="Claude guarderà la foto per descrivere colori, materiali, design"
                    />
                    <Checkbox
                      label="🔍 Cerca info da EAN/Barcode"
                      checked={useBarcode}
                      onChange={setUseBarcode}
                      helpText="Usa il codice a barre per trovare specifiche tecniche aggiuntive"
                    />
                  </InlineStack>

                  {/* BOTTONE GENERA */}
                  <Divider />
                  <InlineStack gap="300" align="end">
                    <Button
                      variant="primary"
                      size="large"
                      onClick={handleGenerate}
                      loading={isGenerating}
                      disabled={selectedResources.length === 0}
                    >
                      {isGenerating
                        ? `Generando ${selectedResources.length} descrizioni...`
                        : `🚀 Genera ${selectedResources.length} descrizioni`}
                    </Button>
                  </InlineStack>

                  {selectedResources.length === 0 && (
                    <Banner tone="info">
                      <p>Vai al tab "📦 Prodotti" e seleziona almeno un prodotto.</p>
                    </Banner>
                  )}
                </BlockStack>
              </Box>
            )}

            {/* TAB PRODOTTI */}
            {activeTab === 1 && (
              <Box padding="400">
                <BlockStack gap="300">
                  {products.length > 0 ? (
                    <IndexTable
                      resourceName={{ singular: "prodotto", plural: "prodotti" }}
                      itemCount={products.length}
                      selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                      onSelectionChange={handleSelectionChange}
                      headings={[
                        { title: "" },
                        { title: "Prodotto" },
                        { title: "Brand" },
                        { title: "Prezzo" },
                        { title: "Media" },
                        { title: "Stato" },
                        { title: "Azioni" },
                      ]}
                    >
                      {rowMarkup}
                    </IndexTable>
                  ) : (
                    <EmptyState
                      heading="Nessun prodotto trovato"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Aggiungi prodotti al tuo negozio per iniziare.</p>
                    </EmptyState>
                  )}
                </BlockStack>
              </Box>
            )}

            {/* TAB RISULTATI */}
            {activeTab === 2 && (
              <Box padding="400">
                <BlockStack gap="400">
                  {generatedResults.length === 0 ? (
                    <Banner tone="info">
                      <p>Nessuna descrizione generata ancora. Seleziona i prodotti e clicca "Genera".</p>
                    </Banner>
                  ) : (
                    <>
                      {/* Azioni bulk */}
                      <InlineStack gap="300" align="space-between">
                        <Text as="h2" variant="headingLg">
                          {successCount} descrizioni pronte
                        </Text>
                        <InlineStack gap="200">
                          <Button
                            variant="primary"
                            onClick={handlePushAll}
                            loading={isPushing}
                            disabled={successCount === 0}
                          >
                            ✅ Pubblica tutte ({successCount}) su Shopify
                          </Button>
                        </InlineStack>
                      </InlineStack>

                      {fetcher.data?.intent === "pushAll" && (
                        <Banner tone="success">
                          <p>Pubblicati {fetcher.data.pushed} prodotti! {fetcher.data.errors > 0 ? `(${fetcher.data.errors} errori)` : ""}</p>
                        </Banner>
                      )}

                      {/* Lista risultati */}
                      {generatedResults.map((result: any) => (
                        <Card key={result.id}>
                          <BlockStack gap="300">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="300" blockAlign="center">
                                {result.image && (
                                  <Thumbnail source={result.image} alt={result.title} size="small" />
                                )}
                                <BlockStack gap="100">
                                  <Text as="h3" variant="headingMd">{result.title}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">{result.vendor} · €{result.price}</Text>
                                </BlockStack>
                              </InlineStack>
                              {result.status === "success" ? (
                                <Badge tone="success">OK</Badge>
                              ) : (
                                <Badge tone="critical">Errore</Badge>
                              )}
                            </InlineStack>

                            {result.status === "success" && (
                              <>
                                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                                  <div
                                    dangerouslySetInnerHTML={{ __html: result.newDescription }}
                                    style={{ lineHeight: "1.6", fontSize: "14px" }}
                                  />
                                </Box>
                                <InlineStack gap="200">
                                  <Button variant="primary" onClick={() => handlePush(result.id, result.newDescription)} loading={isPushing}>
                                    ✅ Pubblica su Shopify
                                  </Button>
                                  <Button onClick={() => navigator.clipboard.writeText(result.newDescription)}>
                                    📋 Copia HTML
                                  </Button>
                                  <Button onClick={() => handleGenerate()} variant="plain">
                                    🔄 Rigenera
                                  </Button>
                                </InlineStack>
                              </>
                            )}

                            {result.status === "error" && (
                              <Banner tone="critical">
                                <p>{result.error || "Errore nella generazione"}</p>
                              </Banner>
                            )}
                          </BlockStack>
                        </Card>
                      ))}
                    </>
                  )}
                </BlockStack>
              </Box>
            )}
          </Tabs>
        </Card>
      </BlockStack>
    </Page>
  );
}
