import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, useNavigate } from "@remix-run/react";
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
  Checkbox,
  Divider,
  Pagination,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const PRODUCTS_PER_PAGE = 100;

// ── LOADER ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const direction = url.searchParams.get("direction") || "next";

  let query: string;

  if (cursor && direction === "next") {
    query = `#graphql
      query getProducts($cursor: String!) {
        products(first: ${PRODUCTS_PER_PAGE}, after: $cursor) {
          edges {
            cursor
            node {
              id
              title
              handle
              vendor
              productType
              tags
              descriptionHtml
              featuredMedia { preview { image { url altText } } }
              variants(first: 1) { edges { node { price barcode sku title } } }
              media(first: 5) { edges { node { preview { image { url altText width height } } } } }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`;
  } else if (cursor && direction === "prev") {
    query = `#graphql
      query getProducts($cursor: String!) {
        products(last: ${PRODUCTS_PER_PAGE}, before: $cursor) {
          edges {
            cursor
            node {
              id
              title
              handle
              vendor
              productType
              tags
              descriptionHtml
              featuredMedia { preview { image { url altText } } }
              variants(first: 1) { edges { node { price barcode sku title } } }
              media(first: 5) { edges { node { preview { image { url altText width height } } } } }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`;
  } else {
    query = `#graphql
      query getProducts {
        products(first: ${PRODUCTS_PER_PAGE}) {
          edges {
            cursor
            node {
              id
              title
              handle
              vendor
              productType
              tags
              descriptionHtml
              featuredMedia { preview { image { url altText } } }
              variants(first: 1) { edges { node { price barcode sku title } } }
              media(first: 5) { edges { node { preview { image { url altText width height } } } } }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`;
  }

  const variables = cursor ? { cursor } : {};
  const response = await admin.graphql(query, { variables });
  const responseJson = await response.json();

  // Conta totale prodotti
  const countResp = await admin.graphql(`#graphql
    query { productsCount { count } }`);
  const countJson = await countResp.json();
  const totalProducts = countJson.data?.productsCount?.count || 0;

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
    price: edge.node.variants.edges[0]?.node?.price || "0.00",
    barcode: edge.node.variants.edges[0]?.node?.barcode || "",
    sku: edge.node.variants.edges[0]?.node?.sku || "",
    images: edge.node.media.edges
      .filter((m: any) => m.node.preview?.image?.url)
      .map((m: any) => ({
        url: m.node.preview.image.url,
        alt: m.node.preview.image.altText,
      })),
  }));

  const pageInfo = responseJson.data.products.pageInfo;

  return json({
    products,
    pageInfo,
    totalProducts,
  });
};

// ── ACTION ───────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

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

      let imageContext = "";
      if (useImage === "true" && product.image) {
        imageContext = `\n- Immagine prodotto disponibile: ${product.image}`;
      }

      const prompt = buildPrompt(product, tone, framework, language, keywords, length, structure, barcodeInfo, imageContext);

      try {
        const messages: any[] = [];

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

  if (intent === "push") {
    const productId = formData.get("productId") as string;
    const description = formData.get("description") as string;
    const mode = formData.get("mode") as string || "replace";

    let finalDescription = description;

    if (mode === "append") {
      const getResp = await admin.graphql(
        `#graphql
        query getProduct($id: ID!) {
          product(id: $id) { descriptionHtml }
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
          product { id descriptionHtml }
          userErrors { field message }
        }
      }`,
      { variables: { input: { id: productId, descriptionHtml: finalDescription } } }
    );

    const responseJson = await response.json();
    const errors = responseJson.data?.productUpdate?.userErrors || [];

    if (errors.length > 0) {
      return json({ intent: "push", success: false, error: errors[0].message });
    }

    return json({ intent: "push", success: true, productId });
  }

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
            product(id: $id) { descriptionHtml }
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

// ── PROMPT BUILDER ───────────────────────────────────────────
function buildPrompt(product: any, tone: string, framework: string, language: string, keywords: string, length: string, structure: string, barcodeInfo: string, imageContext: string) {
  const toneMap: Record<string, string> = {
    professional: "Professionale e autorevole",
    emotional: "Emozionale e coinvolgente",
    technical: "Tecnico e dettagliato",
    luxury: "Luxury, esclusivo e raffinato",
    casual: "Casual e amichevole",
    ironic: "Ironico e originale, smart, con personalità",
    minimal: "Minimal e pulito, ogni parola conta",
  };

  const frameworkMap: Record<string, string> = {
    aida: "AIDA: Attenzione → Interesse → Desiderio → Azione",
    pas: "PAS: Problema → Agitazione → Soluzione",
    fab: "FAB: Feature → Advantage → Benefit",
    storytelling: "Storytelling: racconta una mini-storia o scenario d'uso",
    direct: "Diretto: vai dritto ai benefici",
    comparison: "Confronto: posiziona il prodotto rispetto ad alternative",
  };

  const langMap: Record<string, string> = {
    it: "italiano", en: "inglese", fr: "francese", de: "tedesco", es: "spagnolo",
  };

  const lengthMap: Record<string, string> = {
    short: "BREVE: 50-80 parole, 2-3 frasi",
    medium: "MEDIA: 100-150 parole, con bullet point",
    long: "LUNGA: 200-350 parole, descrizione completa con paragrafi, H3, bullet, CTA",
  };

  const structureMap: Record<string, string> = {
    simple: "Solo paragrafi <p>",
    structured: "<h3> + <p> + <ul><li>",
    rich: "<h3> + <h4> + <p> + <ul><li> + CTA finale in <strong>",
    seo_optimized: "<h3> con keyword + <p> intro + <h4> sottosezioni + <ul><li> con keyword secondarie + CTA, snippet-ready",
  };

  const hasDesc = product.description && product.description.length > 20;
  const cleanDesc = hasDesc ? product.description.replace(/<[^>]+>/g, "").substring(0, 600) : "";

  return `Sei un copywriter e-commerce senior specializzato in SEO e CRO.

PRODOTTO:
- Titolo: ${product.title}
- Brand: ${product.vendor || "non specificato"}
- Categoria: ${product.productType || "non specificata"}
- Prezzo: €${product.price}
- EAN: ${product.barcode || "N/A"}${imageContext}
${cleanDesc ? `- Descrizione attuale: ${cleanDesc}` : ""}
${barcodeInfo ? `\nINFO DAL BARCODE:\n${barcodeInfo}` : ""}

CONFIGURAZIONE:
- Framework: ${frameworkMap[framework] || framework}
- Tono: ${toneMap[tone] || tone}
- Lingua: ${langMap[language] || language}
- Lunghezza: ${lengthMap[length] || length}
- Struttura HTML: ${structureMap[structure] || structure}
${keywords ? `- Keyword SEO da includere: ${keywords}` : ""}

REGOLE:
1. Solo HTML valido — niente markdown né backtick
2. NON iniziare con "Questo prodotto" o "Il/La [nome]"
3. NO frasi generiche tipo "alta qualità" o "il migliore"
4. Bullet point con benefici CONCRETI
5. Titoli H3/H4 creativi e SEO-friendly, mai "Caratteristiche" o "Descrizione"

Scrivi SOLO la descrizione HTML:`;
}

// ── COMPONENTE ───────────────────────────────────────────────
export default function Index() {
  const { products, pageInfo, totalProducts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [tone, setTone] = useState("emotional");
  const [framework, setFramework] = useState("aida");
  const [language, setLanguage] = useState("it");
  const [keywords, setKeywords] = useState("");
  const [length, setLength] = useState("medium");
  const [structure, setStructure] = useState("structured");
  const [useImage, setUseImage] = useState(true);
  const [useBarcode, setUseBarcode] = useState(true);
  const [pushMode, setPushMode] = useState("replace");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [generatedResults, setGeneratedResults] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState(0);

  const filteredProducts = onlyMissing
    ? products.filter((p: any) => !p.description || p.description.length <= 20)
    : products;
  const resourceIDResolver = (product: any) => product.id;
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(filteredProducts, { resourceIDResolver });

  const isGenerating = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isPushing = fetcher.state !== "idle" && (fetcher.formData?.get("intent") === "push" || fetcher.formData?.get("intent") === "pushAll");

  if (fetcher.data?.intent === "generate" && fetcher.data?.results) {
    if (JSON.stringify(generatedResults) !== JSON.stringify(fetcher.data.results)) {
      setTimeout(() => setGeneratedResults(fetcher.data.results), 0);
    }
  }

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

  const goToNextPage = () => {
    if (pageInfo.endCursor) {
      navigate(`/app?cursor=${encodeURIComponent(pageInfo.endCursor)}&direction=next`);
    }
  };

  const goToPrevPage = () => {
    if (pageInfo.startCursor) {
      navigate(`/app?cursor=${encodeURIComponent(pageInfo.startCursor)}&direction=prev`);
    }
  };

  const goToFirstPage = () => {
    navigate(`/app`);
  };

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
    { label: "🔍 SEO-ottimizzata", value: "seo_optimized" },
  ];

  const pushModeOptions = [
    { label: "🔄 Sostituisci descrizione", value: "replace" },
    { label: "➕ Aggiungi sotto l'esistente", value: "append" },
  ];

  const tabs = [
    { id: "settings", content: "⚙️ Impostazioni", panelID: "settings-panel" },
    { id: "products", content: `📦 Prodotti (${products.length}/${totalProducts})`, panelID: "products-panel" },
    { id: "results", content: `✍️ Risultati${generatedResults.length > 0 ? ` (${generatedResults.length})` : ""}`, panelID: "results-panel" },
  ];

  const successCount = generatedResults.filter((r: any) => r.status === "success").length;

  const rowMarkup = filteredProducts.map((product: any, index: number) => {
    const result = generatedResults.find((r: any) => r.id === product.id);
    return (
      <IndexTable.Row id={product.id} key={product.id} selected={selectedResources.includes(product.id)} position={index}>
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
        <IndexTable.Cell>{product.description && product.description.length > 20 ? <Badge tone="success">Presente</Badge> : <Badge tone="critical">Mancante</Badge>}</IndexTable.Cell>
        <IndexTable.Cell>
          {result ? (
            result.status === "success" ? <Badge tone="success">Generata</Badge> : <Badge tone="critical">Errore</Badge>
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

  return (
    <Page>
      <TitleBar title="AI Product Description Generator" />
      <BlockStack gap="500">

        <InlineStack gap="400" wrap={true}>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Totale catalogo</Text>
              <Text as="p" variant="headingLg">{totalProducts}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Caricati</Text>
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
        </InlineStack>

        <Card>
          <Tabs tabs={tabs} selected={activeTab} onSelect={setActiveTab}>
            {activeTab === 0 && (
              <Box padding="400">
                <BlockStack gap="500">
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

                  <TextField
                    label="Keyword SEO (opzionale)"
                    value={keywords}
                    onChange={setKeywords}
                    placeholder="es: scarpe running, sneakers uomo, regalo sportivo"
                    autoComplete="off"
                    helpText="Separa le keyword con virgola"
                  />

                  <Divider />
                  <Text as="h3" variant="headingMd">🔬 Fonti dati per la generazione</Text>
                  <InlineStack gap="600">
                    <Checkbox
                      label="📸 Analizza immagine prodotto (Claude Vision)"
                      checked={useImage}
                      onChange={setUseImage}
                    />
                    <Checkbox
                      label="🔍 Cerca info da EAN/Barcode"
                      checked={useBarcode}
                      onChange={setUseBarcode}
                    />
                  </InlineStack>

                  <Divider />
                  <InlineStack gap="300" align="end">
                    <Button
                      variant="primary"
                      size="large"
                      onClick={handleGenerate}
                      loading={isGenerating}
                      disabled={selectedResources.length === 0}
                    >
                      {isGenerating ? `Generando ${selectedResources.length} descrizioni...` : `🚀 Genera ${selectedResources.length} descrizioni`}
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

            {activeTab === 1 && (
              <Box padding="400">
                <BlockStack gap="300">
                  <InlineStack gap="400" blockAlign="center">
                    <Checkbox
                      label="🔴 Mostra solo prodotti SENZA descrizione"
                      checked={onlyMissing}
                      onChange={setOnlyMissing}
                    />
                  </InlineStack>
                  {/* PAGINAZIONE INFO */}
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Mostrando {products.length} di {totalProducts} prodotti
                    </Text>
                    <InlineStack gap="200">
                      <Button onClick={goToFirstPage} disabled={!searchParams.get("cursor")}>
                        ⏮ Inizio
                      </Button>
                      <Button onClick={goToPrevPage} disabled={!pageInfo.hasPreviousPage}>
                        ← Precedente
                      </Button>
                      <Button onClick={goToNextPage} disabled={!pageInfo.hasNextPage}>
                        Successiva →
                      </Button>
                    </InlineStack>
                  </InlineStack>

                  {products.length > 0 ? (
                    <IndexTable
                      resourceName={{ singular: "prodotto", plural: "prodotti" }}
                      itemCount={filteredProducts.length}
                      selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                      onSelectionChange={handleSelectionChange}
                      headings={[
                        { title: "" },
                        { title: "Prodotto" },
                        { title: "Brand" },
                        { title: "Prezzo" },
                        { title: "Descrizione" },
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

                  {/* PAGINAZIONE BOTTOM */}
                  <InlineStack align="center" gap="200">
                    <Button onClick={goToFirstPage} disabled={!searchParams.get("cursor")}>
                      ⏮ Inizio
                    </Button>
                    <Button onClick={goToPrevPage} disabled={!pageInfo.hasPreviousPage}>
                      ← Precedente
                    </Button>
                    <Button onClick={goToNextPage} disabled={!pageInfo.hasNextPage}>
                      Successiva →
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Box>
            )}

            {activeTab === 2 && (
              <Box padding="400">
                <BlockStack gap="400">
                  {generatedResults.length === 0 ? (
                    <Banner tone="info">
                      <p>Nessuna descrizione generata ancora. Seleziona i prodotti e clicca "Genera".</p>
                    </Banner>
                  ) : (
                    <>
                      <InlineStack gap="300" align="space-between">
                        <Text as="h2" variant="headingLg">{successCount} descrizioni pronte</Text>
                        <Button variant="primary" onClick={handlePushAll} loading={isPushing} disabled={successCount === 0}>
                          ✅ Pubblica tutte ({successCount}) su Shopify
                        </Button>
                      </InlineStack>

                      {fetcher.data?.intent === "pushAll" && (
                        <Banner tone="success">
                          <p>Pubblicati {fetcher.data.pushed} prodotti! {fetcher.data.errors > 0 ? `(${fetcher.data.errors} errori)` : ""}</p>
                        </Banner>
                      )}

                      {generatedResults.map((result: any) => (
                        <Card key={result.id}>
                          <BlockStack gap="300">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="300" blockAlign="center">
                                {result.image && <Thumbnail source={result.image} alt={result.title} size="small" />}
                                <BlockStack gap="100">
                                  <Text as="h3" variant="headingMd">{result.title}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">{result.vendor} · €{result.price}</Text>
                                </BlockStack>
                              </InlineStack>
                              {result.status === "success" ? <Badge tone="success">OK</Badge> : <Badge tone="critical">Errore</Badge>}
                            </InlineStack>

                            {result.status === "success" && (
                              <>
                                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                                  <div dangerouslySetInnerHTML={{ __html: result.newDescription }} style={{ lineHeight: "1.6", fontSize: "14px" }} />
                                </Box>
                                <InlineStack gap="200">
                                  <Button variant="primary" onClick={() => handlePush(result.id, result.newDescription)} loading={isPushing}>
                                    ✅ Pubblica su Shopify
                                  </Button>
                                  <Button onClick={() => navigator.clipboard.writeText(result.newDescription)}>
                                    📋 Copia HTML
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
