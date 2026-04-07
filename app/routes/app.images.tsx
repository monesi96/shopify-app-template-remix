import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
  IndexTable,
  useIndexResourceState,
  Thumbnail,
  EmptyState,
  Select,
  Checkbox,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { loadProductsWithImages, upscaleImages, replaceProductImage } from "../lib/upscale.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const direction = url.searchParams.get("direction") || "next";

  const data = await loadProductsWithImages(admin, cursor, direction);
  return json(data);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upscale") {
    const productsJSON = formData.get("products") as string;
    const scale = parseInt(formData.get("scale") as string) || 4;
    const products = JSON.parse(productsJSON);

    const results = await upscaleImages(products, scale);
    return json({ intent: "upscale", results });
  }

  if (intent === "replaceImage") {
    const productId = formData.get("productId") as string;
    const oldMediaId = formData.get("oldMediaId") as string;
    const newImageUrl = formData.get("newImageUrl") as string;

    const result = await replaceProductImage(admin, productId, oldMediaId, newImageUrl);
    return json({ intent: "replaceImage", ...result });
  }

  return json({ error: "Intent non valido" });
};

export default function ImagesPage() {
  const { products, pageInfo, totalProducts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [scale, setScale] = useState("4");
  const [onlyLowRes, setOnlyLowRes] = useState(false);
  const [onlyLowRes, setOnlyLowRes] = useState(false);
  const [upscaleResults, setUpscaleResults] = useState<any[]>([]);

  const filteredProducts = onlyLowRes
    ? products.filter((p: any) => p.needsUpscale)
    : products;
  const filteredProducts = onlyLowRes
    ? products.filter((p: any) => p.needsUpscale)
    : products;
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(filteredProducts, { resourceIDResolver: (p: any) => p.id });

  const isUpscaling = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "upscale";
  const isReplacing = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "replaceImage";

  if (fetcher.data?.intent === "upscale" && fetcher.data?.results) {
    if (JSON.stringify(upscaleResults) !== JSON.stringify(fetcher.data.results)) {
      setTimeout(() => setUpscaleResults(fetcher.data.results), 0);
    }
  }

  const handleUpscale = useCallback(() => {
    const selected = filteredProducts.filter((p: any) => selectedResources.includes(p.id));
    if (selected.length === 0) return;
    const formData = new FormData();
    formData.append("intent", "upscale");
    formData.append("products", JSON.stringify(selected));
    formData.append("scale", scale);
    fetcher.submit(formData, { method: "POST" });
  }, [selectedResources, products, scale, fetcher]);

  const handleReplace = useCallback((productId: string, oldMediaId: string, newImageUrl: string) => {
    const formData = new FormData();
    formData.append("intent", "replaceImage");
    formData.append("productId", productId);
    formData.append("oldMediaId", oldMediaId);
    formData.append("newImageUrl", newImageUrl);
    fetcher.submit(formData, { method: "POST" });
  }, [fetcher]);

  const goToNextPage = () => {
    if (pageInfo.endCursor) navigate(`/app/images?cursor=${encodeURIComponent(pageInfo.endCursor)}&direction=next`);
  };
  const goToPrevPage = () => {
    if (pageInfo.startCursor) navigate(`/app/images?cursor=${encodeURIComponent(pageInfo.startCursor)}&direction=prev`);
  };
  const goToFirstPage = () => navigate(`/app/images`);

  const scaleOptions = [
    { label: "2x (veloce)", value: "2" },
    { label: "4x (consigliato)", value: "4" },
  ];

  const rowMarkup = filteredProducts.map((product: any, index: number) => (
    <IndexTable.Row
      id={product.id}
      key={product.id}
      selected={selectedResources.includes(product.id)}
      position={index}
    >
      <IndexTable.Cell>
        {product.images[0] ? (
          <Thumbnail source={product.images[0].url} alt={product.title} size="small" />
        ) : (
          <Text as="span" tone="subdued">—</Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">{product.title}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{product.vendor}</IndexTable.Cell>
      <IndexTable.Cell>{product.imageCount}</IndexTable.Cell>
      <IndexTable.Cell>
        {product.minDimension > 0 ? `${product.minDimension}px` : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {product.needsUpscale ? (
          <Badge tone="warning">Da upscalare</Badge>
        ) : product.minDimension >= 1000 ? (
          <Badge tone="success">OK</Badge>
        ) : (
          <Badge>—</Badge>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="🖼️ Upscaling Immagini" />
      <BlockStack gap="500">

        <InlineStack gap="400" wrap={true}>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Prodotti caricati</Text>
              <Text as="p" variant="headingLg">{products.length} / {totalProducts}</Text>
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
              <Text as="p" variant="bodySm" tone="subdued">Upscalate</Text>
              <Text as="p" variant="headingLg">
                {upscaleResults.reduce((acc: number, r: any) => acc + r.images.filter((i: any) => i.status === "success").length, 0)}
              </Text>
            </BlockStack>
          </Card>
        </InlineStack>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingLg">⚙️ Impostazioni upscaling</Text>
            <InlineStack gap="400" wrap={true}>
              <div style={{ minWidth: "200px" }}>
                <Select label="Fattore di ingrandimento" options={scaleOptions} value={scale} onChange={setScale} />
              </div>
            </InlineStack>
            <Banner tone="info">
              <p>Real-ESRGAN via Replicate. Costo ~€0.001 per immagine. Processing: 5-15 secondi per immagine.</p>
            </Banner>
            <InlineStack align="end">
              <Button
                variant="primary"
                size="large"
                onClick={handleUpscale}
                loading={isUpscaling}
                disabled={selectedResources.length === 0}
              >
                {isUpscaling ? "Upscaling in corso..." : `🚀 Upscala ${selectedResources.length} prodotti`}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingLg">📦 Prodotti</Text>
            <Checkbox
              label="🔴 Mostra solo immagini da upscalare (< 1000px)"
              checked={onlyLowRes}
              onChange={setOnlyLowRes}
            />
            <Checkbox
              label="🔴 Mostra solo immagini da upscalare (< 1000px)"
              checked={onlyLowRes}
              onChange={setOnlyLowRes}
            />
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd" tone="subdued">
                Mostrando {products.length} di {totalProducts}
              </Text>
              <InlineStack gap="200">
                <Button onClick={goToFirstPage} disabled={!searchParams.get("cursor")}>⏮ Inizio</Button>
                <Button onClick={goToPrevPage} disabled={!pageInfo.hasPreviousPage}>← Precedente</Button>
                <Button onClick={goToNextPage} disabled={!pageInfo.hasNextPage}>Successiva →</Button>
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
                  { title: "# Foto" },
                  { title: "Min dim." },
                  { title: "Stato" },
                ]}
              >
                {rowMarkup}
              </IndexTable>
            ) : (
              <EmptyState heading="Nessun prodotto" image="">
                <p>Nessun prodotto trovato.</p>
              </EmptyState>
            )}
          </BlockStack>
        </Card>

        {upscaleResults.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">✨ Risultati upscaling</Text>
              {upscaleResults.map((result: any) => (
                <Card key={result.productId}>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">{result.title}</Text>
                    {result.images.map((img: any, idx: number) => (
                      <Card key={idx}>
                        <BlockStack gap="200">
                          {img.status === "success" ? (
                            <>
                              <InlineStack gap="400">
                                <BlockStack gap="100">
                                  <Text as="p" variant="bodySm" tone="subdued">Originale ({img.originalWidth}x{img.originalHeight})</Text>
                                  <img src={img.originalUrl} alt="originale" style={{ maxWidth: "200px", border: "1px solid #ccc" }} />
                                </BlockStack>
                                <BlockStack gap="100">
                                  <Text as="p" variant="bodySm" tone="subdued">Upscalata ({img.newWidth}x{img.newHeight})</Text>
                                  <img src={img.upscaledUrl} alt="upscalata" style={{ maxWidth: "200px", border: "1px solid #4CAF50" }} />
                                </BlockStack>
                              </InlineStack>
                              <InlineStack gap="200">
                                <Button
                                  variant="primary"
                                  onClick={() => handleReplace(result.productId, img.mediaId, img.upscaledUrl)}
                                  loading={isReplacing}
                                >
                                  ✅ Sostituisci su Shopify
                                </Button>
                                <Button onClick={() => window.open(img.upscaledUrl, "_blank")}>
                                  📥 Scarica
                                </Button>
                              </InlineStack>
                            </>
                          ) : (
                            <Banner tone="critical">
                              <p>Errore: {img.error}</p>
                            </Banner>
                          )}
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          </Card>
        )}

      </BlockStack>
    </Page>
  );
}
