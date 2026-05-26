// app/lib/consolidation-merge.server.ts
// Merge engine — Step 3-4. This file currently exposes the READ-ONLY plan
// (dry-run). The mutating execute lands next; nothing here modifies Shopify.
import prisma from "../db.server";

export type PlanVariant = {
  productId: string;
  sku: string;
  title: string;
  size: string | null;
  color: string | null;
  optionValues: { name: string; value: string }[];
  imageUrl: string;
  isMaster: boolean;
};

export type MergePlan = {
  bucketKey: string;
  vendor: string;
  masterProductId: string;
  masterTitle: string;
  featuredImageUrl: string;
  options: { name: string; values: string[] }[];
  variants: PlanVariant[];
  archiveProductIds: string[];
  skuMapping: Record<string, string>;
  warnings: string[];
};

const FALLBACK_SIZE = "Unica";
const FALLBACK_COLOR = "Unico";

// Build the merge plan from already-scanned candidates. Pure read (DB only):
// no Shopify calls, so it is always safe to run.
export async function buildMergePlan(
  shop: string,
  bucketKey: string,
  masterProductId: string,
  featuredImageUrl?: string,
): Promise<MergePlan> {
  const members = await prisma.consolidationCandidate.findMany({
    where: { shop, bucketKey, status: "pending" },
    orderBy: { productTitle: "asc" },
  });

  const warnings: string[] = [];
  if (members.length < 2) warnings.push("Il gruppo ha meno di 2 prodotti.");
  if (members.length > 0 && !members.some((m) => m.productId === masterProductId)) {
    warnings.push("Master non valido per questo gruppo; uso il primo prodotto.");
    masterProductId = members[0].productId;
  }

  const hasSize = members.some((m) => m.detectedSize);
  const hasColor = members.some((m) => m.detectedColor);
  if (!hasSize && !hasColor) {
    warnings.push("Nessuna taglia/colore rilevata: impossibile creare varianti distinte. Rivedi il gruppo o ignoralo.");
  }

  const usedCombos = new Map<string, string>();
  const variants: PlanVariant[] = members.map((m) => {
    const optionValues: { name: string; value: string }[] = [];
    if (hasSize) optionValues.push({ name: "Taglia", value: m.detectedSize || FALLBACK_SIZE });
    if (hasColor) optionValues.push({ name: "Colore", value: m.detectedColor || FALLBACK_COLOR });
    const combo = optionValues.map((o) => o.value).join(" / ");
    if (usedCombos.has(combo)) {
      warnings.push(`Combinazione duplicata "${combo}": ${usedCombos.get(combo)} e ${m.sku || m.productTitle}. Una variante andrà in conflitto.`);
    } else {
      usedCombos.set(combo, m.sku || m.productTitle);
    }
    return {
      productId: m.productId,
      sku: m.sku || "",
      title: m.productTitle,
      size: m.detectedSize,
      color: m.detectedColor,
      optionValues,
      imageUrl: m.imageUrl || "",
      isMaster: m.productId === masterProductId,
    };
  });

  const options: { name: string; values: string[] }[] = [];
  if (hasSize) options.push({ name: "Taglia", values: [...new Set(variants.map((v) => v.optionValues.find((o) => o.name === "Taglia")!.value))] });
  if (hasColor) options.push({ name: "Colore", values: [...new Set(variants.map((v) => v.optionValues.find((o) => o.name === "Colore")!.value))] });

  const master = members.find((m) => m.productId === masterProductId);
  const skuMapping: Record<string, string> = {};
  for (const v of variants) if (v.sku) skuMapping[v.sku] = v.optionValues.map((o) => o.value).join(" / ");

  return {
    bucketKey,
    vendor: master?.vendor || members[0]?.vendor || "",
    masterProductId,
    masterTitle: master?.productTitle || "",
    featuredImageUrl: featuredImageUrl || master?.imageUrl || "",
    options,
    variants,
    archiveProductIds: members.filter((m) => m.productId !== masterProductId).map((m) => m.productId),
    skuMapping,
    warnings,
  };
}
