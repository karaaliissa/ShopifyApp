const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { URL } = require("url");
const bodyParser = require("body-parser");
console.log("🔑 KEY:", process.env.SHOPIFY_API_KEY);
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const BASE_URL = "https://cropndtop.myshopify.com/admin/api/2024-01/orders.json";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'fseedd97f00ae0b0cf83b3b60e8a1dc8';
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || 'your_secret_here';
const REDIRECT_URI = "https://shopify-proxy-wlo0.onrender.com/auth/callback";
const SCOPES = "read_orders,write_orders";


const shopTokens = {}; // 🔐 In-memory storage for shop tokens

// =======================
// 🔐 Shopify OAuth Routes
// =======================
app.get("/auth", (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop parameter");

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${REDIRECT_URI}&state=random`;

  res.redirect(installUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send("Missing shop or code");

  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });

    const accessToken = response.data.access_token;
    shopTokens[shop] = accessToken;

    console.log(`✅ OAuth success for ${shop}`);

    res.redirect(`https://karaaliissa.github.io/ShopifyFront/?shop=${shop}`);
  } catch (err) {
    console.error("❌ OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

// =====================
// 📦 Helper: Pagination
// =====================
function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match || match.length < 2) return null;
  try {
    const nextUrl = new URL(match[1]);
    return nextUrl.searchParams.get("page_info");
  } catch (err) {
    console.error("❌ Invalid link header format:", match[1]);
    return null;
  }
}

// =============================
// 📦 Orders - List & Pagination
// =============================
app.get("/api/orders", async (req, res) => {
  const shop = req.query.shop;
  const token = shopTokens[shop];
  if (!token) return res.status(401).json({ error: "Missing token for shop" });

  const pageInfo = req.query.page_info;
  const url = pageInfo
    ? `${BASE_URL}?limit=100&page_info=${pageInfo}`
    : `${BASE_URL}?limit=100&status=any`;

  try {
    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    const nextPageInfo = extractNextPageInfo(response.headers.link);

    res.json({
      orders: response.data.orders.map((order) => ({
        ...order,
        device: (order.note_attributes || []).find((a) => a.name === "device")?.value || "Unknown",
        source: (order.note_attributes || []).find((a) => a.name === "source")?.value || "Unknown",
        channel: order.source_name || "Unknown",
      })),
      nextPageInfo,
    });
  } catch (error) {
    console.error("❌ Orders error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// =======================
// 📦 Order Count Endpoint
// =======================
app.get("/api/orders/count", async (req, res) => {
  const shop = req.query.shop;
  const token = shopTokens[shop];
  if (!token) return res.status(401).json({ error: "Missing token for shop" });

  try {
    const response = await axios.get(
      `https://${shop}/admin/api/2024-01/orders/count.json`,
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch order count" });
  }
});

// =======================
// 🏷️ Tag Count Summary
// =======================
app.get("/api/tag-counts", async (req, res) => {
  const shop = req.query.shop;
  const token = shopTokens[shop];
  if (!token) return res.status(401).json({ error: "Missing token for shop" });

  const allOrders = [];
  let pageInfo = null;

  try {
    do {
      const url = pageInfo
        ? `https://${shop}/admin/api/2024-01/orders.json?limit=100&page_info=${pageInfo}`
        : `https://${shop}/admin/api/2024-01/orders.json?limit=100&status=any`;

      const response = await axios.get(url, {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      });

      allOrders.push(...(response.data.orders || []));
      pageInfo = extractNextPageInfo(response.headers.link);
    } while (pageInfo);

    const tagCounts = {};
    for (const order of allOrders) {
      const tags = (order.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length === 0) {
        tagCounts["Pending"] = (tagCounts["Pending"] || 0) + 1;
      } else {
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    }

    res.json({
      total: allOrders.length,
      countsByTag: tagCounts,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to count tags" });
  }
});

// ===========================
// 💰 Unpaid Order Count
// ===========================
app.get('/api/unpaid-order-count', async (req, res) => {
  const shop = req.query.shop;
  const token = shopTokens[shop];
  if (!token) return res.status(401).json({ error: "Missing token for shop" });

  try {
    const response = await axios.get(
      `https://${shop}/admin/api/2024-01/orders/count.json?status=any&financial_status=pending`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ count: response.data.count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch unpaid order count' });
  }
});

// ========================
// ✅ Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Shopify proxy server running on port ${PORT}`);
});
