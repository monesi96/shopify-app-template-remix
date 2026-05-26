import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { buildMergePlan } from "../lib/consolidation-merge.server";

export const config = { maxDuration: 60 };

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const body = await request.json().catch(() => ({} as any));
  const { intent, productIds, masterProductId, featuredImageUrl } = body || {};

  if (intent === "plan") {
    if (!Array.isArray(productIds) || productIds.length < 2 || !masterProductId) {
      return json({ error: "Servono almeno 2 prodotti selezionati e un master." }, { status: 400 });
    }
    const plan = await buildMergePlan(session.shop, productIds, masterProductId, featuredImageUrl);
    return json({ plan });
  }

  return json({ error: "Intent non supportato." }, { status: 400 });
}
