import express from "express";
import fetch from "node-fetch";
import ProxyAgent from "proxy-agent";

/* =========================
   CONFIG
========================= */

const proxyUrl = process.env.PROXY_URL;
const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const PRODUCTS_PER_GROUP = 50;

const API_DEAL_PRODUCT_IDS =
  "https://reco-public.rec.mp.microsoft.com/channels/Reco/V8.0/Lists/Computed/Deal?Market=ar&Language=es&ItemTypes=Game&deviceFamily=Windows.Xbox&count=2000&skipitems=0";

const API_CATALOG =
  "https://displaycatalog.mp.microsoft.com/v7.0/products";

const API_CATALOG_PARAM_PRODUCT_IDS = "?bigIds=";
const API_CATALOG_PARAM_FILTER = "&market=AR&languages=es-ar";

/* =========================
   CACHE
========================= */

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 минут

/* =========================
   EXPRESS
========================= */

const app = express();

/* =========================
   HELPERS
========================= */

async function fetcher(url) {
  const response = await fetch(url, { agent });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function runBatches(tasks, batchSize = 5) {
  const results = [];

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }

  return results;
}

async function getProductIds(url) {
  const json = await fetcher(url);

  const ids = json.Items
    .filter(item => item.ItemType === "Game")
    .map(item => item.Id);

  const groups = [];

  for (let i = 0; i < ids.length; i += PRODUCTS_PER_GROUP) {
    groups.push(ids.slice(i, i + PRODUCTS_PER_GROUP));
  }

  return groups;
}

function flatGroups(groups) {
  let data = [];

  for (let i = 0; i < groups.length; i++) {
    data = [...data, ...groups[i].Products];
  }

  return data;
}

function mapProducts(products) {
  return products.map(element => {
    const image =
      element.LocalizedProperties?.[0]?.Images?.find(
        i => i.ImagePurpose === "Poster"
      ) || null;

    return {
      ProductId: element.ProductId,
      Title: element.LocalizedProperties?.[0]?.ProductTitle || null,
      Poster: image ? image.Uri : null,
      Price:
        element.DisplaySkuAvailabilities?.[0]?.Availabilities?.[0]
          ?.OrderManagementData?.Price?.ListPrice || null
    };
  });
}

/* =========================
   MAIN SCRAPER
========================= */

async function scrapeDeals() {
  const idGroups = await getProductIds(API_DEAL_PRODUCT_IDS);

  const requests = idGroups.map(group => {
    const ids = group.join(",");
    const url =
      API_CATALOG +
      API_CATALOG_PARAM_PRODUCT_IDS +
      ids +
      API_CATALOG_PARAM_FILTER;

    return fetcher(url);
  });

  const response = await runBatches(requests, 5);
  const flat = flatGroups(response);
  return mapProducts(flat);
}

/* =========================
   ROUTES
========================= */

app.get("/", (req, res) => {
  res.send("Xbox Store API is running 🚀");
});

app.get("/api/list/Deal", async (req, res) => {
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    console.log("Serving from cache");
    return res.json(cache);
  }

  try {
    const data = await scrapeDeals();
    cache = data;
    cacheTime = Date.now();
    res.json(data);
  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(500).json({ error: "Failed to fetch deals" });
  }
});

/* =========================
   START SERVER
========================= */
console.log("PROXY_URL:", proxyUrl);
console.log("Agent created:", !!agent); 
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
