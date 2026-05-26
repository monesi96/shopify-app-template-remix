import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Page, Card, BlockStack, InlineStack, Button, Text, Badge, Thumbnail, Banner, TextField } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getGroups, getLatestScan } from "../lib/consolidation.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [groups, scan] = await Promise.all([getGroups(session.shop), getLatestScan(session.shop)]);
  return json({ groups, scan });
}

export default function Consolidation() {
  const { groups, scan } = useLoaderData<typeof loader>();
  const scanFetcher = useFetcher<{ scanId: number }>();
  const procFetcher = useFetcher<any>();
  const ignoreFetcher = useFetcher<{ ok?: boolean }>();
  const cancelFetcher = useFetcher<{ ok?: boolean }>();
  const revalidator = useRevalidator();
  const [vendor, setVendor] = useState("");
  const running = scan?.status === "queued" || scan?.status === "running";

  // Avvia scansione -> appena ho lo scanId, inizia a triggerare il worker
  useEffect(() => {
    if (scanFetcher.data?.scanId) {
      procFetcher.submit({ scanId: scanFetcher.data.scanId }, { method: "post", action: "/api/consolidation/process", encType: "application/json" });
    }
  }, [scanFetcher.data]);

  // Re-trigger finché il batch non è done, poi revalida la pagina
  useEffect(() => {
    const r = procFetcher.data?.results?.[0];
    if (r && r.done === false) {
      procFetcher.submit({ scanId: r.scanId }, { method: "post", action: "/api/consolidation/process", encType: "application/json" });
    } else if (r && (r.done === true || r.error)) {
      revalidator.revalidate();
    }
  }, [procFetcher.data]);

  // Dopo aver ignorato un gruppo, ricarica la lista (il gruppo sparisce)
  useEffect(() => {
    if (ignoreFetcher.data?.ok) revalidator.revalidate();
  }, [ignoreFetcher.data]);

  // Dopo aver fermato la scansione, ricarica lo stato
  useEffect(() => {
    if (cancelFetcher.data?.ok) revalidator.revalidate();
  }, [cancelFetcher.data]);

  const startScan = () => scanFetcher.submit({ vendor }, { method: "post", action: "/api/consolidation/scan" });
  const resumeScan = () => scan && procFetcher.submit({ scanId: scan.id }, { method: "post", action: "/api/consolidation/process", encType: "application/json" });
  const stopScan = () => scan && cancelFetcher.submit({ scanId: scan.id }, { method: "post", action: "/api/consolidation/cancel", encType: "application/json" });

  return (
    <Page title="Consolidamento Varianti" subtitle="Trova prodotti separati che sono in realtà varianti dello stesso prodotto">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <TextField label="Filtra per vendor (opzionale, es. Havaianas)" helpText="La scansione considera solo i prodotti ATTIVI." value={vendor} onChange={setVendor} autoComplete="off" />
            <InlineStack gap="300" align="start">
              <Button variant="primary" disabled={running} loading={scanFetcher.state !== "idle"} onClick={startScan}>
                Avvia scansione
              </Button>
              {running && (
                <>
                  <Button onClick={resumeScan} loading={procFetcher.state !== "idle"}>Riprendi</Button>
                  <Button tone="critical" onClick={stopScan} loading={cancelFetcher.state !== "idle"}>Ferma scansione</Button>
                </>
              )}
              {scan && (
                <Text as="span" tone="subdued">
                  Ultima scansione: {scan.status} · {scan.totalScanned} prodotti
                </Text>
              )}
            </InlineStack>
          </BlockStack>
        </Card>
        {scan?.status === "failed" && (
          <Banner tone="critical" title="La scansione è fallita">
            <Text as="p" variant="bodySm">{scan.errorLog || "Errore sconosciuto (nessun dettaglio salvato)."}</Text>
          </Banner>
        )}
        {groups.length === 0 && !running && (
          <Banner tone="info">Nessun gruppo trovato. Avvia una scansione per popolare i candidati.</Banner>
        )}
        {groups.map((g) => (
          <Card key={g.bucketKey}>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h3" variant="headingMd">{g.vendor} — {g.titleNormalized || "(senza titolo)"}</Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="info">{`${g.count} prodotti`}</Badge>
                  {g.hashConsistent ? <Badge tone="success">Foto coerenti</Badge> : <Badge tone="warning">Foto divergenti</Badge>}
                  <Button
                    variant="plain"
                    tone="critical"
                    loading={ignoreFetcher.state !== "idle" && ignoreFetcher.formData?.get("bucketKey") === g.bucketKey}
                    onClick={() => ignoreFetcher.submit({ bucketKey: g.bucketKey }, { method: "post", action: "/api/consolidation/ignore" })}
                  >
                    Ignora
                  </Button>
                </InlineStack>
              </InlineStack>
              <BlockStack gap="200">
                {g.members.map((m: any) => {
                  const attrs = [m.detectedSize && `Taglia ${m.detectedSize}`, m.detectedColor && `Colore ${m.detectedColor}`].filter(Boolean).join(" · ");
                  return (
                    <InlineStack key={m.id} gap="300" blockAlign="center">
                      <Thumbnail source={m.imageUrl || ""} alt={m.productTitle} size="small" />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd">{m.productTitle}</Text>
                        <Text as="span" tone="subdued" variant="bodySm">
                          SKU {m.sku || "—"}{attrs ? ` · ${attrs}` : " · nessun attributo rilevato"}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}
