const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const { URL } = require("url");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
require("dotenv").config();

const app = express();

// ✅ Parse JSON bodies
app.use(bodyParser.json());

// ✅ CONFIG
const API_SECRET = process.env.API_SECRET || 'd172de1719f2ae3a0a1964e7b65fe505';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map(ip => ip.trim());
const BASE_URL = 'https://cropndtop.myshopify.com/admin/api/2024-01/orders.json';


// ✅ CORS — only allow frontend origin
app.use(cors({
  origin: ['https://karaaliissa.github.io'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-App-Token', 'Authorization']
}));

// ✅ LOGIN route — keep this outside all secure middlewares
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (username !== process.env.ADMIN_USERNAME)
    return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

// ✅ Secure Middlewares (only affect remaining /api/* routes)

// Rate Limit
app.use('/api/', rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50
}));

// IP Allowlist
app.use('/api/', (req, res, next) => {
  next();
});

// App Token Check
app.use('/api/', (req, res, next) => {
  const token = req.headers['x-app-token'];
  if (token !== API_SECRET) {
    return res.status(403).json({ error: 'Forbidden - Invalid token' });
  }
  next();
});

// JWT Auth Check
app.use('/api/', (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
});
function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>; rel="next"/);
  return match ? match[1] : null;
}

// ✅ You can add secured routes here (e.g. /api/orders etc.)
// Example:
// app.get('/api/test', (req, res) => res.json({ message: "Protected route success" }));
// ✅ Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const response = await axios.get('https://cropndtop.myshopify.com/admin/api/2024-01/orders.json?limit=100&status=any', {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    res.json({ orders: response.data.orders });
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});
app.get('/api/orders/count', async (req, res) => {
  try {
    const response = await axios.get('https://cropndtop.myshopify.com/admin/api/2024-01/orders/count.json', {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    res.json({ count: response.data.count });
  } catch (err) {
    console.error('Error fetching count:', err.message);
    res.status(500).json({ error: 'Failed to fetch order count' });
  }
});
app.get("/api/tag-counts", async (req, res) => {
  const allOrders = [];
  let pageInfo = null;

  try {
    do {
      const url = pageInfo
        ? `${BASE_URL}?limit=100&page_info=${pageInfo}`
        : `${BASE_URL}?limit=100&status=any`;

      const response = await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      const orders = response.data.orders || [];
      allOrders.push(...orders);

      const linkHeader = response.headers.link;
      pageInfo = extractNextPageInfo(linkHeader);
    } while (pageInfo);

    const tagCounts = {};
    let totalOrders = allOrders.length;

    for (const order of allOrders) {
      const tags = (order.tags || "")
        .split(",")
        .map(t => t.trim())
        .filter(t => t !== "");

      if (tags.length === 0) {
        tagCounts["Pending"] = (tagCounts["Pending"] || 0) + 1;
      } else {
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    }

    res.json({
      total: totalOrders,
      countsByTag: tagCounts,
    });
  } catch (error) {
    console.error("❌ Failed to count tags:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch tag counts" });
  }
});
app.post("/api/save-order-tag", async (req, res) => {
  const { orderId, tag, financial_status, fulfillment_status } = req.body;
  if (!orderId || !tag) return res.status(400).json({ error: "orderId and tag are required" });

  try {
    await axios.put(
      `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}.json`,
      { order: { id: orderId, tags: tag } },
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    if (tag === "Shipped" && (!fulfillment_status || fulfillment_status === "unfulfilled")) {
      const fulfillmentOrdersRes = await axios.get(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}/fulfillment_orders.json`,
        {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );

      const openFulfillmentOrders = (fulfillmentOrdersRes.data.fulfillment_orders || []).filter(
        (fo) => fo.status !== "closed"
      );

      if (openFulfillmentOrders.length > 0) {
        const fulfillment = {
          fulfillment: {
            message: "Shipped via API",
            notify_customer: false,
            line_items_by_fulfillment_order: openFulfillmentOrders.map((fo) => ({
              fulfillment_order_id: fo.id,
            })),
          },
        };

        await axios.post(
          `https://cropndtop.myshopify.com/admin/api/2024-01/fulfillments.json`,
          fulfillment,
          {
            headers: {
              "X-Shopify-Access-Token": SHOPIFY_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );
      } else {
        console.log(`⚠️ No open fulfillment orders for order ${orderId}, skipping fulfillment.`);
      }
    }

    if (tag === "Completed") {
      const orderDetailsRes = await axios.get(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}.json`,
        {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );

      const order = orderDetailsRes.data.order;
      const amount = parseFloat(order.total_price);

      await axios.post(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}/transactions.json`,
        {
          transaction: {
            kind: "capture",
            status: "success",
            amount: amount,
            gateway: "manual",
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(`✅ Forced manual payment recorded for order ${orderId}`);
    }

    res.json({ success: true, updatedTag: tag });
  } catch (err) {
    console.error("❌ Failed to update order:", {
      status: err.response?.status,
      data: err.response?.data,
      headers: err.response?.headers,
    });
    res.status(500).json({ error: "Failed to update tag/payment/fulfillment" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
