import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Page, Card, BlockStack, InlineStack, Button, Text, Badge, Thumbnail, Banner, TextField, Checkbox, RadioButton } from "@shopify/polaris";
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
            <InlineStack gap="300" align="start" blockAlign="center">
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
          <MergeGroup key={g.bucketKey} group={g} onChanged={() => revalidator.revalidate()} />
        ))}
      </BlockStack>
    </Page>
  );
}

function MergeGroup({ group, onChanged }: { group: any; onChanged: () => void }) {
  const planFetcher = useFetcher<any>();
  const ignoreFetcher = useFetcher<{ ok?: boolean }>();
  const [selected, setSelected] = useState<Record<string, boolean>>(
    () => Object.fromEntries(group.members.map((m: any) => [m.productId, true])),
  );
  const [masterId, setMasterId] = useState<string>(group.members[0]?.productId || "");
  const [photoUrl, setPhotoUrl] = useState<string>(group.members[0]?.imageUrl || "");

  useEffect(() => {
    if (ignoreFetcher.data?.ok) onChanged();
  }, [ignoreFetcher.data]);

  const selectedIds = group.members.filter((m: any) => selected[m.productId]).map((m: any) => m.productId);
  const effectiveMaster = selected[masterId] ? masterId : selectedIds[0];
  const plan = planFetcher.data?.plan;

  const preview = () =>
    planFetcher.submit(
      { intent: "plan", productIds: selectedIds, masterProductId: effectiveMaster, featuredImageUrl: photoUrl },
      { method: "post", action: "/api/consolidation/merge", encType: "application/json" },
    );

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">{group.vendor} — {group.titleNormalized || "(senza titolo)"}</Text>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="info">{`${group.count} prodotti`}</Badge>
            {group.hashConsistent ? <Badge tone="success">Foto coerenti</Badge> : <Badge tone="warning">Foto divergenti</Badge>}
            <Button
              variant="plain"
              tone="critical"
              loading={ignoreFetcher.state !== "idle"}
              onClick={() => ignoreFetcher.submit({ bucketKey: group.bucketKey }, { method: "post", action: "/api/consolidation/ignore" })}
            >
              Ignora
            </Button>
          </InlineStack>
        </InlineStack>

        <Text as="p" tone="subdued" variant="bodySm">
          Spunta i prodotti che sono lo stesso articolo, scegli il master e la foto principale, poi genera l'anteprima.
        </Text>

        <BlockStack gap="200">
          {group.members.map((m: any) => {
            const attrs = [m.detectedSize && `Taglia ${m.detectedSize}`, m.detectedColor && `Colore ${m.detectedColor}`].filter(Boolean).join(" · ");
            const isSel = !!selected[m.productId];
            return (
              <InlineStack key={m.id} gap="300" blockAlign="center">
                <Checkbox label="Includi nel merge" labelHidden checked={isSel} onChange={(v) => setSelected((s) => ({ ...s, [m.productId]: v }))} />
                <Thumbnail source={m.imageUrl || ""} alt={m.productTitle} size="small" />
                <BlockStack gap="050">
                  <Text as="span" variant="bodyMd">{m.productTitle}</Text>
                  <Text as="span" tone="subdued" variant="bodySm">
                    SKU {m.sku || "—"}{attrs ? ` · ${attrs}` : " · nessun attributo rilevato"}
                  </Text>
                  <InlineStack gap="400">
                    <RadioButton label="Master" checked={masterId === m.productId} disabled={!isSel} name={`master-${group.bucketKey}`} onChange={() => setMasterId(m.productId)} />
                    <RadioButton label="Foto principale" checked={photoUrl === m.imageUrl} disabled={!m.imageUrl} name={`photo-${group.bucketKey}`} onChange={() => setPhotoUrl(m.imageUrl)} />
                  </InlineStack>
                </BlockStack>
              </InlineStack>
            );
          })}
        </BlockStack>

        <InlineStack gap="300">
          <Button onClick={preview} disabled={selectedIds.length < 2} loading={planFetcher.state !== "idle"}>
            Anteprima merge ({selectedIds.length})
          </Button>
        </InlineStack>

        {plan && <MergePlanView plan={plan} />}
      </BlockStack>
    </Card>
  );
}

function MergePlanView({ plan }: { plan: any }) {
  return (
    <Card background="bg-surface-secondary">
      <BlockStack gap="200">
        <Text as="h4" variant="headingSm">Anteprima del merge (nessuna modifica applicata)</Text>
        {plan.warnings?.length > 0 && (
          <Banner tone="warning">
            <BlockStack gap="100">
              {plan.warnings.map((w: string, i: number) => (
                <Text as="p" variant="bodySm" key={i}>{w}</Text>
              ))}
            </BlockStack>
          </Banner>
        )}
        <Text as="p" variant="bodySm">Prodotto master: <b>{plan.masterTitle || "—"}</b></Text>
        <Text as="p" variant="bodySm">
          Opzioni: {plan.options?.length ? plan.options.map((o: any) => `${o.name} (${o.values.join(", ")})`).join(" · ") : "—"}
        </Text>
        <BlockStack gap="100">
          {plan.variants?.map((v: any) => (
            <InlineStack key={v.productId} gap="200" blockAlign="center">
              <Thumbnail source={v.imageUrl || ""} alt={v.title} size="extraSmall" />
              <Text as="span" variant="bodySm">
                {v.optionValues.map((o: any) => o.value).join(" / ") || "—"} · SKU {v.sku || "—"}{v.isMaster ? " · master" : ""}
              </Text>
            </InlineStack>
          ))}
        </BlockStack>
        <Text as="p" tone="subdued" variant="bodySm">
          Verranno archiviati {plan.archiveProductIds?.length || 0} prodotti (gli slave). Il mapping SKU → variante sarà salvato nel metafield danea.sku_mapping del master.
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          L'esecuzione (che applica davvero il merge) arriva nello step successivo: prima validiamo che questo piano sia corretto.
        </Text>
      </BlockStack>
    </Card>
  );
}
