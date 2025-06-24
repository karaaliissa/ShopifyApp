const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const { URL } = require("url");
require("dotenv").config();

const app = express();

// ✅ Security Middleware
const API_SECRET = process.env.API_SECRET || 'your-very-strong-secret-token';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'shpat_...';

app.use(bodyParser.json());

// ✅ CORS only for trusted domain(s)
const corsOptions = {
  origin: ['https://karaaliissa.github.io'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-App-Token']
};
app.use(cors(corsOptions));

// ✅ Rate limit
app.use('/api/', rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50
}));

// ✅ Token check
app.use('/api/', (req, res, next) => {
  const token = req.headers['x-app-token'];
  if (token !== API_SECRET) {
    return res.status(403).json({ error: 'Forbidden - Invalid token' });
  }
  next();
});

const BASE_URL = 'https://cropndtop.myshopify.com/admin/api/2024-01/orders.json';

function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  return new URL(match[1]).searchParams.get('page_info');
}

// ====================== ROUTES ======================

app.get("/api/orders", async (req, res) => {
  const pageInfo = req.query.page_info;
  const url = pageInfo
    ? `${BASE_URL}?limit=100&page_info=${pageInfo}`
    : `${BASE_URL}?limit=100&status=any`;

  try {
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const orders = response.data.orders || [];
    const nextPageInfo = extractNextPageInfo(response.headers.link);

    res.json({
      orders: orders.map(order => ({
        ...order,
        device: (order.note_attributes || []).find(a => a.name === 'device')?.value || 'Unknown',
        source: (order.note_attributes || []).find(a => a.name === 'source')?.value || 'Unknown',
        channel: order.source_name || 'Unknown',
      })),
      nextPageInfo
    });
  } catch (err) {
    console.error('Orders error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.get("/api/orders/count", async (req, res) => {
  try {
    const response = await axios.get(
      "https://cropndtop.myshopify.com/admin/api/2024-01/orders/count.json",
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order count' });
  }
});

app.get("/api/unpaid-order-count", async (req, res) => {
  try {
    const response = await axios.get(
      "https://cropndtop.myshopify.com/admin/api/2024-01/orders/count.json?status=any&financial_status=pending",
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );
    res.json({ count: response.data.count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch unpaid order count' });
  }
});

app.post("/api/save-order-tag", async (req, res) => {
  const { orderId, tag, financial_status, fulfillment_status, line_items } = req.body;

  if (!orderId || !tag)
    return res.status(400).json({ error: "orderId and tag are required" });

  try {
    await axios.put(
      `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}.json`,
      { order: { id: orderId, tags: tag } },
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    // ✅ Fulfill if needed
    if (tag === "Shipped" && (!fulfillment_status || fulfillment_status === "unfulfilled")) {
      const fulfillmentOrdersRes = await axios.get(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}/fulfillment_orders.json`,
        {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            "Content-Type": "application/json"
          }
        }
      );

      const openOrders = (fulfillmentOrdersRes.data.fulfillment_orders || []).filter(fo => fo.status !== 'closed');

      if (openOrders.length) {
        await axios.post(
          `https://cropndtop.myshopify.com/admin/api/2024-01/fulfillments.json`,
          {
            fulfillment: {
              message: "Shipped via dashboard",
              notify_customer: false,
              line_items_by_fulfillment_order: openOrders.map(fo => ({
                fulfillment_order_id: fo.id
              }))
            }
          },
          {
            headers: {
              "X-Shopify-Access-Token": SHOPIFY_TOKEN,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Save order error:', err.message);
    res.status(500).json({ error: 'Failed to update tag or fulfillment' });
  }
});

app.get("/api/tag-counts", async (req, res) => {
  let allOrders = [];
  let pageInfo = null;

  try {
    do {
      const url = pageInfo
        ? `${BASE_URL}?limit=100&page_info=${pageInfo}`
        : `${BASE_URL}?limit=100&status=any`;

      const response = await axios.get(url, {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      });

      allOrders.push(...response.data.orders);
      pageInfo = extractNextPageInfo(response.headers.link);
    } while (pageInfo);

    const tagCounts = {};
    for (const order of allOrders) {
      const tags = (order.tags || "").split(',').map(t => t.trim()).filter(Boolean);
      if (tags.length === 0) tagCounts['Pending'] = (tagCounts['Pending'] || 0) + 1;
      else tags.forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1);
    }

    res.json({ total: allOrders.length, countsByTag: tagCounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tag counts' });
  }
});

// ====================== START ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Secure proxy running on port ${PORT}`);
});
