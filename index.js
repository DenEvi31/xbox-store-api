// src/index.js
import express from "express";
import fetch from "node-fetch";
import ProxyAgent from "proxy-agent";

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 8080;
const PROXY_URL = (process.env.PROXY_URL || "").trim() || undefined;
const AGENT = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

const PRODUCTS_PER_GROUP = 50;
const BATCH_SIZE = 5; // parallel requests per batch
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const API_DEAL_PRODUCT_IDS = "https://reco-public.rec.mp.microsoft.com/channels/Reco/V8.0/Lists/Computed/Deal?Market=ar&Language=es&ItemTypes=Game&deviceFamily=Windows.Xbox&count=2000&skipitems=0";
const API_CATALOG = "https://displaycatalog.mp.microsoft.com/v7.0/products";
const API_CATALOG_PARAM_PRODUCT_IDS = "?bigIds=";
const API_CATALOG_PARAM_FILTER = "&market=AR&languages=es-ar";

/* =========================
   CACHE
========================= */
let cache = null;
let cacheTime = 0;

/* =========================
   EXPRESS
========================= */
const app = express();

/* =========================
   HELPERS
========================= */

function log(...args) {
  // uniform prefix
  console.log("[xbox-api]", ...args);
}

async function fetcher(url) {
  // Single fetch with agent & simple headers; throws on non-OK
  try {
    log("fetcher: requesting", url);
    if (AGENT) {
      log("fetcher: using proxy agent ->", PROXY_URL);
    } else {
      log("fetcher: no proxy agent (direct request)");
    }

    const response = await fetch(url, {
      // pass agent even if undefined — harmless
      agent: AGENT,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; XboxStoreApi/1.0)",
        Accept: "application/json, text/plain, */*"
      },
      // optionally we could implement a timeout via AbortController if needed
    });

    if (!response.ok) {
      const txt = await response.text().catch(()=>"(body read fail)");
      throw new Error(`HTTP ${response.status} ${response.statusText} - ${txt}`);
    }

    const json = await response.json();
    return json;
  } catch (err) {
    log("fetcher: ERROR for", url, "|", err && err.message ? err.message : err);
    throw err;
  }
}

/**
 * Run functions in batches to limit concurrency.
 * tasks = array of functions returning Promises (not promises yet).
 */
async function runBatches(tasks, batchSize = BATCH_SIZE) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batchFns = tasks.slice(i, i + batchSize);
    log(`runBatches: running batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tasks.length / batchSize)} size=${batchFns.length}`);
    const batchPromises = batchFns.map(fn => fn());
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    // small backoff can be added here if desired:
    // await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

async function getProductIds(url) {
  const json = await fetcher(url);
  if (!json || !Array.isArray(json.Items)) {
    throw new Error("getProductIds: unexpected response structure");
  }

  const ids = json.Items.filter(item => item && item.ItemType === "Game").map(item => item.Id);
  log("getProductIds: total game ids:", ids.length);

  const groups = [];
  for (let i = 0; i < ids.length; i += PRODUCTS_PER_GROUP) {
    groups.push(ids.slice(i, i + PRODUCTS_PER_GROUP));
  }
  log("getProductIds: groups count:", groups.length, "productsPerGroup:", PRODUCTS_PER_GROUP);
  return groups;
}

function flatGroups(groups) {
  // groups are responses from catalog endpoint: each has .Products
  const data = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g && Array.isArray(g.Products)) {
      data.push(...g.Products);
    } else {
      log("flatGroups: warning - group missing Products at index", i);
    }
  }
  return data;
}

function mapProducts(products) {
  return products.map(p => {
    const local = (p.LocalizedProperties && p.LocalizedProperties[0]) || {};
    const image = (local.Images || []).find(i => i.ImagePurpose === "Poster");
    const sku = (p.DisplaySkuAvailabilities && p.DisplaySkuAvailabilities[0] && p.DisplaySkuAvailabilities[0].Availabilities && p.DisplaySkuAvailabilities[0].Availabilities[0]) || {};
    const price = (sku.OrderManagementData && sku.OrderManagementData.Price) || null;

    return {
      ProductId: p.ProductId || null,
      Title: local.ProductTitle || null,
      ShortTitle: local.ShortTitle || null,
      Poster: image ? image.Uri : null,
      Price: price ? price.ListPrice : null,
      Currency: price ? price.CurrencyCode : null,
      // you can extend fields here
    };
  });
}

/* =========================
   SCRAPING FLOW
========================= */

async function scrapeDeals() {
  log("scrapeDeals: start");
  const groupsOfIds = await getProductIds(API_DEAL_PRODUCT_IDS);

  // build array of functions that when called will fetch a group
  const requestFns = groupsOfIds.map(group => {
    const ids = group.join(",");
    const url = `${API_CATALOG}${API_CATALOG_PARAM_PRODUCT_IDS}${ids}${API_CATALOG_PARAM_FILTER}`;
    return () => fetcher(url);
  });

  // run them in batches
  const responses = await runBatches(requestFns, BATCH_SIZE);
  log("scrapeDeals: got responses groups:", responses.length);

  const flat = flatGroups(responses);
  log("scrapeDeals: total products fetched from groups:", flat.length);

  const mapped = mapProducts(flat);
  log("scrapeDeals: mapped products count:", mapped.length);

  return mapped;
}

/* =========================
   ROUTES
========================= */

app.get("/", (req, res) => {
  res.send("Xbox Store API is running 🚀");
});

app.get("/api/list/Deal", async (req, res) => {
  // serve from cache
  try {
    if (cache && (Date.now() - cacheTime) < CACHE_TTL) {
      log("route /api/list/Deal: serving from cache");
      return res.json(cache);
    }

    log("route /api/list/Deal: cache miss -> scraping");
    const data = await scrapeDeals();
    cache = data;
    cacheTime = Date.now();
    return res.json(data);
  } catch (err) {
    log("route /api/list/Deal: error:", err && err.message ? err.message : err);
    // include some debug info but avoid leaking secrets
    return res.status(500).json({ error: "Failed to fetch deals", detail: (err && err.message) ? err.message : "unknown" });
  }
});

/* =========================
   START
========================= */

log("STARTING xbox-store-api");
log("PROXY_URL defined:", !!PROXY_URL);
if (PROXY_URL) {
  log("PROXY_URL (first 120 chars):", PROXY_URL.length > 120 ? PROXY_URL.slice(0, 120) + "..." : PROXY_URL);
}
log("AGENT created:", !!AGENT, AGENT ? AGENT.constructor.name : "(none)");
log("BATCH_SIZE:", BATCH_SIZE, "PRODUCTS_PER_GROUP:", PRODUCTS_PER_GROUP, "CACHE_TTL_ms:", CACHE_TTL);

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});
