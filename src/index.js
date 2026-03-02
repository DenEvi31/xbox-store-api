import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_DEAL_PRODUCT_IDS =
  "https://reco-public.rec.mp.microsoft.com/channels/Reco/V8.0/Lists/Computed/Deal?Market=ar&Language=es&ItemTypes=Game&deviceFamily=Windows.Xbox&count=2000&skipitems=0";

const API_CATALOG = "https://displaycatalog.mp.microsoft.com/v7.0/products";
const API_CATALOG_PARAM_PRODUCT_IDS = "?bigIds=";
const API_CATALOG_PARAM_FILTER = "&market=AR&languages=es-ar";
const PRODUCTS_PER_GROUP = 50;

async function getProductIds(url) {
  const response = await fetch(url);
  const json = await response.json();

  const data = json.Items
    .filter((item) => item.ItemType === "Game")
    .map((item) => item.Id);

  const groups = [];
  for (let i = 0; i < data.length; i += PRODUCTS_PER_GROUP) {
    groups.push(data.slice(i, i + PRODUCTS_PER_GROUP));
  }

  return groups;
}

async function fetcher(url) {
  const response = await fetch(url);
  return response.json();
}

function flatGroups(groups) {
  let data = [];
  for (let i = 0; i < groups.length; i++) {
    data = [...data, ...groups[i].Products];
  }
  return data;
}

function mapProduct(products) {
  return products.map((element) => {
    const image =
      element.LocalizedProperties?.[0]?.Images?.find(
        (i) => i.ImagePurpose === "Poster"
      ) || null;

    return {
      ProductId: element.ProductId,
      Title: element.LocalizedProperties?.[0]?.ProductTitle,
      Poster: image ? image.Uri : null,
      Price:
        element.DisplaySkuAvailabilities?.[0]?.Availabilities?.[0]
          ?.OrderManagementData?.Price?.ListPrice || null,
    };
  });
}

async function scrapeDeals() {
  const idGroups = await getProductIds(API_DEAL_PRODUCT_IDS);

  const requests = idGroups.map((group) => {
    const ids = group.join(",");
    const url =
      API_CATALOG + API_CATALOG_PARAM_PRODUCT_IDS + ids + API_CATALOG_PARAM_FILTER;
    return fetcher(url);
  });

  const response = await Promise.all(requests);
  const flat = flatGroups(response);
  return mapProduct(flat);
}

// 🔥 API endpoint
app.get("/api/list/Deal", async (req, res) => {
  try {
    const data = await scrapeDeals();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch deals" });
  }
});

app.get("/", (req, res) => {
  res.send("Xbox Store API is running 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
