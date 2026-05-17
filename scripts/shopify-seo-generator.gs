/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   🚀 SHOPIFY SEO DESCRIPTION GENERATOR                  ║
 * ║   Google Apps Script — versione standalone               ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║ SETUP (una tantum):                                      ║
 * ║  1. Apri Google Sheets → Estensioni → Apps Script        ║
 * ║  2. Incolla questo file, salva                           ║
 * ║  3. Compila i campi in CONFIG (sotto)                    ║
 * ║  4. Ricarica il foglio → menu "🚀 SEO Generator"         ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║ FLUSSO:                                                  ║
 * ║  1️⃣  Carica prodotti senza descrizione                  ║
 * ║  2️⃣  Genera descrizioni (auto ogni 5 min o manuale)     ║
 * ║  3️⃣  Rivedi nel foglio, poi pubblica su Shopify         ║
 * ╚══════════════════════════════════════════════════════════╝
 */

// ─────────────────────────────────────────────────────────────
// ⚙️ CONFIGURAZIONE — compila questi valori prima di usare
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  // ── Shopify ──────────────────────────────────────────────
  SHOP_DOMAIN:       "YOUR_STORE.myshopify.com",  // es: mio-negozio.myshopify.com
  ADMIN_API_TOKEN:   "shpat_YOUR_TOKEN_HERE",     // Token da Custom App (Admin API)
  API_VERSION:       "2024-04",

  // ── Claude / Anthropic ───────────────────────────────────
  ANTHROPIC_KEY:     "sk-ant-YOUR_KEY_HERE",      // Chiave API Claude
  CLAUDE_MODEL:      "claude-haiku-4-5-20251001", // Modello (haiku = veloce e economico)

  // ── Batch e performance ──────────────────────────────────
  BATCH_SIZE:        50,   // Prodotti per esecuzione (max ~50 per restare nei 6 min di GAS)
  MAX_PRODUCTS:      2000, // Limite caricamento (metti 0 per nessun limite)

  // ── Stile delle descrizioni ──────────────────────────────
  // Tono: professional | emotional | technical | luxury | casual | ironic | minimal
  TONE:        "emotional",

  // Framework copy: aida | pas | fab | storytelling | direct | comparison
  FRAMEWORK:   "aida",

  // Lingua: it | en | fr | de | es
  LANGUAGE:    "it",

  // Lunghezza: short (50-80 p.) | medium (100-150 p.) | long (200-350 p.)
  LENGTH:      "medium",

  // Struttura HTML: simple | structured | rich | seo_optimized
  STRUCTURE:   "seo_optimized",

  // Keyword extra da includere in tutte le descrizioni (es. "arredamento, design italiano")
  // Lascia vuoto "" per nessuna keyword globale
  GLOBAL_KEYWORDS: "",

  // ── Fonti dati ───────────────────────────────────────────
  // Analizza immagine prodotto con Claude Vision (più accurato, leggermente più lento)
  USE_IMAGES:       true,

  // Cerca info prodotto tramite barcode/EAN su UPCItemDB (gratuito, nessuna chiave)
  USE_BARCODE_LOOKUP: true,

  // Usa descrizioni esistenti come riferimento di stile (campione di 3-5 prodotti)
  USE_STYLE_EXAMPLES: true,

  // ── Foglio Google ────────────────────────────────────────
  SHEET_NAME:  "Prodotti SEO",
};

// ─────────────────────────────────────────────────────────────
// INDICI COLONNE (non modificare)
// ─────────────────────────────────────────────────────────────
const COL = {
  ID:        1,  // A - ID numerico Shopify
  GID:       2,  // B - gid://shopify/Product/...
  TITLE:     3,  // C - Titolo
  VENDOR:    4,  // D - Brand
  TYPE:      5,  // E - Categoria
  BARCODE:   6,  // F - EAN/Barcode
  IMAGE:     7,  // G - URL prima immagine
  GENERATED: 8,  // H - Descrizione generata (HTML)
  STATUS:    9,  // I - Stato
};

// ─────────────────────────────────────────────────────────────
// MENU
// ─────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🚀 SEO Generator")
    .addItem("1️⃣  Carica prodotti senza descrizione", "loadProductsWithoutDescription")
    .addSeparator()
    .addItem("2️⃣  Genera prossime " + CONFIG.BATCH_SIZE + " descrizioni", "generateNextBatch")
    .addItem("▶️  Avvia auto-generazione (ogni 5 min)", "setupAutoTrigger")
    .addItem("⏹️  Ferma auto-generazione", "removeAutoTrigger")
    .addSeparator()
    .addItem("3️⃣  Pubblica su Shopify (solo 'Generate')", "pushAllToShopify")
    .addSeparator()
    .addItem("📊 Stato attuale", "showStatus")
    .addItem("🔄 Riprova righe con errore", "retryErrors")
    .addToUi();
}

// ─────────────────────────────────────────────────────────────
// STEP 1: CARICA PRODOTTI ATTIVI SENZA DESCRIZIONE
// ─────────────────────────────────────────────────────────────
function loadProductsWithoutDescription() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getOrCreateSheet();

  // Header e formattazione
  sheet.clearContents();
  const headers = ["ID", "GID", "Titolo", "Brand", "Categoria", "EAN/Barcode", "Immagine", "Descrizione Generata", "Stato"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight("bold")
    .setBackground("#1a73e8")
    .setFontColor("white");
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(COL.GENERATED, 400);
  sheet.setColumnWidth(COL.IMAGE, 200);
  sheet.setColumnWidth(COL.TITLE, 250);

  ui.alert("⏳ Caricamento in corso", "Sto scansionando il catalogo per trovare prodotti attivi senza descrizione.\nPotrebbe richiedere 20-60 secondi per cataloghi grandi.", ui.ButtonSet.OK);

  let pageInfo = null;
  let totalLoaded = 0;
  let row = 2;
  const maxPages = CONFIG.MAX_PRODUCTS > 0 ? Math.ceil(CONFIG.MAX_PRODUCTS / 250) : 999;
  let page = 0;

  do {
    // Nota: quando c'è page_info, Shopify ignora gli altri parametri di filtro
    let url;
    if (pageInfo) {
      url = `https://${CONFIG.SHOP_DOMAIN}/admin/api/${CONFIG.API_VERSION}/products.json?page_info=${pageInfo}&limit=250&fields=id,title,vendor,product_type,body_html,variants,images`;
    } else {
      url = `https://${CONFIG.SHOP_DOMAIN}/admin/api/${CONFIG.API_VERSION}/products.json?status=active&limit=250&fields=id,title,vendor,product_type,body_html,variants,images`;
    }

    const resp = shopifyGet(url);
    if (!resp) break;

    const products = resp.data.products || [];

    // Filtra: solo prodotti senza descrizione reale (anche se HTML vuoto)
    const missing = products.filter(p => {
      // Salta prodotti non attivi (nelle pagine paginate status non è filtrato)
      if (p.status && p.status !== "active") return false;
      const clean = (p.body_html || "").replace(/<[^>]+>/g, "").trim();
      return clean.length === 0;
    });

    if (missing.length > 0) {
      const rows = missing.map(p => [
        String(p.id),
        `gid://shopify/Product/${p.id}`,
        p.title || "",
        p.vendor || "",
        p.product_type || "",
        (p.variants && p.variants[0] ? (p.variants[0].barcode || p.variants[0].sku || "") : ""),
        (p.images && p.images[0] ? p.images[0].src : ""),
        "",           // H: descrizione generata (vuota)
        "Da generare" // I: stato iniziale
      ]);
      sheet.getRange(row, 1, rows.length, headers.length).setValues(rows);
      row += rows.length;
      totalLoaded += missing.length;
    }

    // Estrai page_info per la pagina successiva
    pageInfo = resp.nextPageInfo;
    page++;

    // Rispetta i rate limit Shopify (max 2 req/s in REST)
    Utilities.sleep(500);

    if (CONFIG.MAX_PRODUCTS > 0 && totalLoaded >= CONFIG.MAX_PRODUCTS) break;

  } while (pageInfo && page < maxPages);

  // Colora le righe "Da generare" in giallo
  if (row > 2) {
    sheet.getRange(2, COL.STATUS, row - 2, 1).setBackground("#fff3cd");
  }

  SpreadsheetApp.flush();

  ui.alert(
    "✅ Caricamento completato",
    `Trovati ${totalLoaded} prodotti attivi senza descrizione.\n\nOra usa:\n• "Genera prossime ${CONFIG.BATCH_SIZE} descrizioni" per iniziare manualmente\n• "Avvia auto-generazione" per processare tutto in automatico ogni 5 minuti`,
    ui.ButtonSet.OK
  );
}

// ─────────────────────────────────────────────────────────────
// STEP 2: GENERA DESCRIZIONI (batch)
// ─────────────────────────────────────────────────────────────
function generateNextBatch() {
  const sheet = getOrCreateSheet();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    log("Foglio vuoto — esegui prima 'Carica prodotti senza descrizione'.");
    return;
  }

  // Trova righe da processare
  const statusValues = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
  const toProcess = [];
  for (let i = 0; i < statusValues.length; i++) {
    if (statusValues[i][0] === "Da generare") {
      toProcess.push(i + 2); // +2: 0-based + header
      if (toProcess.length >= CONFIG.BATCH_SIZE) break;
    }
  }

  if (toProcess.length === 0) {
    // Nessuna riga "Da generare" rimasta — rimuovi trigger se esiste
    removeAutoTrigger();
    log("✅ Tutte le descrizioni sono state generate! Ora puoi pubblicare su Shopify.");
    return;
  }

  // Carica esempi di stile una sola volta per il batch
  const styleExamples = CONFIG.USE_STYLE_EXAMPLES ? getStyleExamples() : [];

  let processed = 0;
  let errors = 0;

  for (const rowIdx of toProcess) {
    const rowData = sheet.getRange(rowIdx, 1, 1, 9).getValues()[0];

    const product = {
      id:          String(rowData[COL.ID - 1]),
      gid:         String(rowData[COL.GID - 1]),
      title:       String(rowData[COL.TITLE - 1]),
      vendor:      String(rowData[COL.VENDOR - 1]),
      productType: String(rowData[COL.TYPE - 1]),
      barcode:     String(rowData[COL.BARCODE - 1]),
      image:       String(rowData[COL.IMAGE - 1]),
    };

    // Mostra progresso nella cella stato
    sheet.getRange(rowIdx, COL.STATUS).setValue("⏳ In elaborazione...").setBackground("#d1ecf1");
    SpreadsheetApp.flush();

    try {
      // 1. Cerca info prodotto online tramite EAN (se disponibile)
      let barcodeInfo = "";
      if (CONFIG.USE_BARCODE_LOOKUP && product.barcode && product.barcode.length > 5) {
        barcodeInfo = lookupBarcode(product.barcode, product.title, product.vendor);
      }

      // 2. Genera descrizione con Claude
      const description = generateWithClaude(product, styleExamples, barcodeInfo);

      // 3. Salva nel foglio
      sheet.getRange(rowIdx, COL.GENERATED).setValue(description);
      sheet.getRange(rowIdx, COL.STATUS).setValue("Generata").setBackground("#d4edda");
      processed++;

    } catch (e) {
      sheet.getRange(rowIdx, COL.STATUS)
        .setValue("❌ " + e.message.substring(0, 100))
        .setBackground("#f8d7da");
      errors++;
      Logger.log("Errore prodotto " + product.title + ": " + e.message);
    }

    SpreadsheetApp.flush();
    Utilities.sleep(200);
  }

  // Calcola rimanenti
  const remaining = statusValues.filter(s => s[0] === "Da generare").length - toProcess.length;

  if (remaining === 0) {
    removeAutoTrigger();
  }

  Logger.log(`Batch completato: ${processed} ok, ${errors} errori, ${remaining} rimanenti`);
}

// ─────────────────────────────────────────────────────────────
// RICERCA INFO PRODOTTO TRAMITE BARCODE (UPCItemDB — gratuito)
// ─────────────────────────────────────────────────────────────
function lookupBarcode(barcode, title, vendor) {
  try {
    // UPCItemDB: lookup gratuito per EAN/UPC (limite 100 req/giorno)
    const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`;
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "Accept": "application/json" },
    });

    if (resp.getResponseCode() === 200) {
      const data = JSON.parse(resp.getContentText());
      const item = data.items && data.items[0];
      if (item) {
        const parts = [];
        if (item.description) parts.push(item.description);
        if (item.brand)       parts.push("Brand: " + item.brand);
        if (item.category)    parts.push("Categoria: " + item.category);
        if (item.weight)      parts.push("Peso: " + item.weight);
        if (item.dimension)   parts.push("Dimensioni: " + item.dimension);
        if (item.color)       parts.push("Colore: " + item.color);
        if (item.material)    parts.push("Materiale: " + item.material);
        if (parts.length > 0) return parts.join("\n");
      }
    }
  } catch (e) {
    Logger.log("Barcode lookup fallito per " + barcode + ": " + e.message);
  }

  // Fallback: chiedi a Claude di usare le sue conoscenze sull'EAN
  return lookupBarcodeViaClaude(barcode, title, vendor);
}

function lookupBarcodeViaClaude(barcode, title, vendor) {
  try {
    const resp = callClaude(
      `Sei un esperto di prodotti consumer. Cerca nella tua conoscenza il prodotto con codice EAN/barcode: ${barcode}\nNome prodotto: "${title}"\nBrand: "${vendor}"\n\nFornisci una breve scheda tecnica: caratteristiche principali, materiali, dimensioni se noti, uso previsto. Sii specifico e concreto. Se non hai info certe su questo EAN, descrivi le caratteristiche tipiche di questo tipo di prodotto basandoti sul nome. Rispondi SOLO con le info, senza prefissi o spiegazioni meta.`,
      null,
      200
    );
    return resp;
  } catch (e) {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────
// GENERAZIONE DESCRIZIONE CON CLAUDE
// ─────────────────────────────────────────────────────────────
function generateWithClaude(product, styleExamples, barcodeInfo) {
  const prompt = buildPrompt(product, styleExamples, barcodeInfo);

  const maxTokens = CONFIG.LENGTH === "long" ? 1200 : CONFIG.LENGTH === "medium" ? 700 : 400;

  // Prova con immagine se disponibile
  if (CONFIG.USE_IMAGES && product.image && product.image.startsWith("http")) {
    try {
      const imgResp = UrlFetchApp.fetch(product.image, { muteHttpExceptions: true });
      if (imgResp.getResponseCode() === 200) {
        const base64 = Utilities.base64Encode(imgResp.getContent());
        const contentType = (imgResp.getHeaders()["Content-Type"] || "image/jpeg").split(";")[0];

        const body = {
          model: CONFIG.CLAUDE_MODEL,
          max_tokens: maxTokens,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: contentType, data: base64 } },
              { type: "text", text: prompt },
            ],
          }],
        };

        return callClaudeRaw(body);
      }
    } catch (e) {
      Logger.log("Image fetch fallita per " + product.title + ": " + e.message);
    }
  }

  // Fallback: solo testo
  return callClaude(prompt, null, maxTokens);
}

// ─────────────────────────────────────────────────────────────
// PROMPT BUILDER — adattato dalle best practice SEO 2026
// ─────────────────────────────────────────────────────────────
function buildPrompt(product, styleExamples, barcodeInfo) {
  const toneMap = {
    professional: "Professionale e autorevole",
    emotional:    "Emozionale e coinvolgente",
    technical:    "Tecnico e dettagliato",
    luxury:       "Luxury, esclusivo e raffinato",
    casual:       "Casual e amichevole",
    ironic:       "Ironico e originale, smart, con personalità",
    minimal:      "Minimal e pulito, ogni parola conta",
  };

  const frameworkMap = {
    aida:        "AIDA: Attenzione → Interesse → Desiderio → Azione",
    pas:         "PAS: Problema → Agitazione → Soluzione",
    fab:         "FAB: Feature → Advantage → Benefit",
    storytelling:"Storytelling: racconta una mini-storia o scenario d'uso",
    direct:      "Diretto: vai dritto ai benefici",
    comparison:  "Confronto: posiziona il prodotto rispetto ad alternative",
  };

  const langMap = { it: "italiano", en: "inglese", fr: "francese", de: "tedesco", es: "spagnolo" };

  const lengthMap = {
    short:  "BREVE: 50-80 parole, 2-3 frasi max",
    medium: "MEDIA: 100-150 parole, con un paio di bullet point",
    long:   "LUNGA: 200-350 parole, paragrafi + H3 + bullet + CTA",
  };

  const structureMap = {
    simple:        "Solo paragrafi <p>",
    structured:    "<h3> + <p> + <ul><li>",
    rich:          "<h3> + <h4> + <p> + <ul><li> + CTA finale in <strong>",
    seo_optimized: "<h3> con keyword + <p> intro + <h4> sottosezioni + <ul><li> con keyword secondarie + CTA snippet-ready",
  };

  // Esempi di stile (prodotti reali del catalogo)
  let styleSection = "";
  if (styleExamples && styleExamples.length > 0) {
    styleSection = "\n\n🎨 STILE DI RIFERIMENTO — adatta tono e registro a questi esempi reali del nostro catalogo:\n";
    styleExamples.forEach((ex, i) => {
      styleSection += `\nEsempio ${i + 1} — "${ex.title}":\n${ex.description}\n`;
    });
  }

  const keywordsLine = CONFIG.GLOBAL_KEYWORDS
    ? `- Keyword da includere: ${CONFIG.GLOBAL_KEYWORDS}`
    : "";

  return `Sei un SEO specialist e copywriter e-commerce senior, specializzato in product page SEO 2026. Conosci le best practice di SEMrush, Ahrefs, Shopify e Google Search Quality Guidelines.${styleSection}

📦 PRODOTTO DA OTTIMIZZARE:
- Titolo: ${product.title}
- Brand: ${product.vendor || "non specificato"}
- Categoria: ${product.productType || "non specificata"}
- EAN/Barcode: ${product.barcode || "N/A"}
${barcodeInfo ? `\n🔍 INFO TECNICHE (da ricerca EAN/catalogo):\n${barcodeInfo}` : ""}

⚙️ CONFIGURAZIONE:
- Framework copywriting: ${frameworkMap[CONFIG.FRAMEWORK] || CONFIG.FRAMEWORK}
- Tono di voce: ${toneMap[CONFIG.TONE] || CONFIG.TONE}
- Lingua: ${langMap[CONFIG.LANGUAGE] || CONFIG.LANGUAGE}
- Lunghezza: ${lengthMap[CONFIG.LENGTH] || CONFIG.LENGTH}
- Struttura HTML: ${structureMap[CONFIG.STRUCTURE] || CONFIG.STRUCTURE}
${keywordsLine}

🎯 BEST PRACTICE SEO 2026 (OBBLIGATORIE):

1. **Keyword strategy**: 1 keyword primaria + 3-5 long-tail correlate (varianti naturali che un acquirente cercherebbe). Densità 3-5 menzioni ogni 300 parole.

2. **Search intent commerciale**: scrivi per chi sta valutando l'acquisto. Usa "comprare", "scegli", "ideale per", "perfetto per" naturalmente.

3. **Features → Benefits**: trasforma ogni caratteristica in un beneficio concreto.
   ❌ "Batteria 5000mAh"
   ✅ "Fino a 48 ore di autonomia — perfetto per i viaggi lunghi"

4. **Problem-solving nelle prime 2 frasi**: identifica il problema che il prodotto risolve.

5. **Specifica e concreta**: ZERO parole vuote ("alta qualità", "premium", "il migliore"). Sostituisci con NUMERI, MATERIALI, USE CASE specifici.

6. **Scannability**: H3/H4 informativi, bullet brevi, paragrafi max 3 righe.

7. **AI Overview ready**: struttura snippet-friendly per Google AI.

8. **Long-tail nei sottotitoli H4**: i sottotitoli devono includere variazioni della keyword.

9. **CTA soft**: chiudi con urgenza o esclusività senza essere pushy.

🚫 ERRORI DA EVITARE:
- NON iniziare con "Questo prodotto" o il titolo del prodotto
- NON usare generic copy o manufacturer descriptions
- NON keyword stuffing
- NON ripetere info già nel titolo
- NON titoli generici ("Caratteristiche", "Descrizione", "Dettagli")
- NON inventare certificazioni, premi, statistiche

📝 OUTPUT: SOLO HTML valido (no markdown, no backtick, no spiegazioni aggiuntive). Pronto per Shopify.

Genera ora la descrizione HTML ottimizzata:`;
}

// ─────────────────────────────────────────────────────────────
// CARICA ESEMPI DI STILE (prodotti CON descrizione reale)
// ─────────────────────────────────────────────────────────────
function getStyleExamples() {
  try {
    const url = `https://${CONFIG.SHOP_DOMAIN}/admin/api/${CONFIG.API_VERSION}/products.json?status=active&limit=20&fields=id,title,body_html`;
    const resp = shopifyGet(url);
    if (!resp) return [];

    return (resp.data.products || [])
      .filter(p => {
        const clean = (p.body_html || "").replace(/<[^>]+>/g, "").trim();
        return clean.length > 80; // solo descrizioni sostanziali
      })
      .slice(0, 3)
      .map(p => ({
        title: p.title,
        // Primo paragrafo della descrizione (max 400 char) — basta per dare stile
        description: (p.body_html || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 400),
      }));
  } catch (e) {
    Logger.log("getStyleExamples error: " + e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 3: PUBBLICA SU SHOPIFY
// ─────────────────────────────────────────────────────────────
function pushAllToShopify() {
  const sheet = getOrCreateSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const allData = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const toPublish = allData
    .map((row, i) => ({ row, rowIdx: i + 2 }))
    .filter(({ row }) => row[COL.STATUS - 1] === "Generata" && row[COL.GENERATED - 1]);

  if (toPublish.length === 0) {
    SpreadsheetApp.getUi().alert(
      "Nessun prodotto da pubblicare",
      "Non ci sono righe con stato 'Generata'. Genera prima le descrizioni.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    "Conferma pubblicazione",
    `Stai per pubblicare ${toPublish.length} descrizioni su Shopify.\nL'operazione sovrascriverà le descrizioni esistenti (che erano vuote).\n\nContinua?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  let pushed = 0;
  let errors = 0;

  for (const { row, rowIdx } of toPublish) {
    const productId = String(row[COL.ID - 1]);
    const description = String(row[COL.GENERATED - 1]);

    sheet.getRange(rowIdx, COL.STATUS).setValue("⏳ Pubblicazione...").setBackground("#d1ecf1");
    SpreadsheetApp.flush();

    try {
      const url = `https://${CONFIG.SHOP_DOMAIN}/admin/api/${CONFIG.API_VERSION}/products/${productId}.json`;
      const resp = UrlFetchApp.fetch(url, {
        method: "put",
        headers: {
          "X-Shopify-Access-Token": CONFIG.ADMIN_API_TOKEN,
          "Content-Type": "application/json",
        },
        payload: JSON.stringify({ product: { id: Number(productId), body_html: description } }),
        muteHttpExceptions: true,
      });

      if (resp.getResponseCode() === 200) {
        sheet.getRange(rowIdx, COL.STATUS).setValue("✅ Pubblicata").setBackground("#c3e6cb");
        pushed++;
      } else {
        const errMsg = resp.getContentText().substring(0, 120);
        sheet.getRange(rowIdx, COL.STATUS)
          .setValue("❌ HTTP " + resp.getResponseCode() + ": " + errMsg)
          .setBackground("#f8d7da");
        errors++;
      }
    } catch (e) {
      sheet.getRange(rowIdx, COL.STATUS)
        .setValue("❌ " + e.message.substring(0, 100))
        .setBackground("#f8d7da");
      errors++;
    }

    SpreadsheetApp.flush();
    Utilities.sleep(600); // Shopify REST: 2 req/s → 600ms di sicurezza
  }

  ui.alert(
    "✅ Pubblicazione completata",
    `Pubblicati con successo: ${pushed}\nErrori: ${errors}`,
    ui.ButtonSet.OK
  );
}

// ─────────────────────────────────────────────────────────────
// AUTO-TRIGGER
// ─────────────────────────────────────────────────────────────
function setupAutoTrigger() {
  removeAutoTrigger();

  ScriptApp.newTrigger("generateNextBatch")
    .timeBased()
    .everyMinutes(5)
    .create();

  SpreadsheetApp.getUi().alert(
    "✅ Auto-generazione attivata",
    `Il sistema genererà automaticamente ${CONFIG.BATCH_SIZE} descrizioni ogni 5 minuti.\n\nPuoi chiudere questo foglio — lo script gira sul server Google.\nUsa "Ferma auto-generazione" quando hai finito.`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function removeAutoTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "generateNextBatch")
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ─────────────────────────────────────────────────────────────
// RIPROVA ERRORI
// ─────────────────────────────────────────────────────────────
function retryErrors() {
  const sheet = getOrCreateSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const statuses = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
  let count = 0;
  for (let i = 0; i < statuses.length; i++) {
    if (String(statuses[i][0]).startsWith("❌")) {
      sheet.getRange(i + 2, COL.STATUS).setValue("Da generare").setBackground("#fff3cd");
      count++;
    }
  }

  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert(
    "Reset errori",
    `${count} righe con errore reimpostate a "Da generare".\nOra riesegui la generazione.`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ─────────────────────────────────────────────────────────────
// STATO
// ─────────────────────────────────────────────────────────────
function showStatus() {
  const sheet = getOrCreateSheet();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("Foglio vuoto", "Carica prima i prodotti.", SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }

  const statuses = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
  let waiting = 0, generated = 0, published = 0, errors = 0, other = 0;

  statuses.forEach(([s]) => {
    const str = String(s);
    if (str === "Da generare")    waiting++;
    else if (str === "Generata")  generated++;
    else if (str.startsWith("✅")) published++;
    else if (str.startsWith("❌")) errors++;
    else other++;
  });

  const total = lastRow - 1;
  const pct = total > 0 ? Math.round(((generated + published) / total) * 100) : 0;

  SpreadsheetApp.getUi().alert(
    "📊 Stato generazione SEO",
    `Totale prodotti nel foglio: ${total}\n\n` +
    `⏳ Da generare:  ${waiting}\n` +
    `✍️  Generate:    ${generated}\n` +
    `✅  Pubblicate:  ${published}\n` +
    `❌  Errori:      ${errors}\n\n` +
    `Progresso: ${pct}% completato`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ─────────────────────────────────────────────────────────────
// UTILITY: CHIAMATE HTTP
// ─────────────────────────────────────────────────────────────

// GET Shopify con gestione paginazione (restituisce anche nextPageInfo)
function shopifyGet(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      headers: { "X-Shopify-Access-Token": CONFIG.ADMIN_API_TOKEN },
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      Logger.log("Shopify GET error " + resp.getResponseCode() + ": " + url);
      return null;
    }

    const data = JSON.parse(resp.getContentText());
    const linkHeader = resp.getHeaders()["Link"] || resp.getHeaders()["link"] || "";
    const nextPageInfo = extractNextPageInfo(linkHeader);

    return { data, nextPageInfo };
  } catch (e) {
    Logger.log("shopifyGet exception: " + e.message);
    return null;
  }
}

function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Chiama Claude con solo testo
function callClaude(prompt, imageData, maxTokens) {
  const body = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: maxTokens || 700,
    messages: [{ role: "user", content: prompt }],
  };
  return callClaudeRaw(body);
}

// Chiama Claude con payload arbitrario
function callClaudeRaw(body) {
  const resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error("Claude API " + resp.getResponseCode() + ": " + resp.getContentText().substring(0, 200));
  }

  const data = JSON.parse(resp.getContentText());
  let text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text.trim() : "";

  // Rimuovi eventuali wrapper markdown
  text = text.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  return text;
}

// Utility log
function log(msg) {
  Logger.log(msg);
}

// Crea o recupera il foglio di lavoro
function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }
  return sheet;
}
