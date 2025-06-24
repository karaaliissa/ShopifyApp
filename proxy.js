const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { URL } = require("url");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const BASE_URL = "https://cropndtop.myshopify.com/admin/api/2024-01/orders.json";
require('dotenv').config();
const TOKEN = process.env.SHOPIFY_TOKEN;

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

app.get("/api/orders", async (req, res) => {
  const pageInfo = req.query.page_info;
  const url = pageInfo
    ? `${BASE_URL}?limit=100&page_info=${pageInfo}`
    : `${BASE_URL}?limit=100&status=any`;
  console.log("➡️ Fetching:", url);

  try {
    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": TOKEN,
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
    console.error("Shopify pagination error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch paginated orders" });
  }
});

app.get("/api/orders/count", async (req, res) => {
  try {
    const response = await axios.get(
      "https://cropndtop.myshopify.com/admin/api/2024-01/orders/count.json",
      {
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error("Error fetching order count:", error.message);
    res.status(500).json({ error: "Failed to fetch order count" });
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
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    if (tag === "Shipped" && (!fulfillment_status || fulfillment_status === "unfulfilled")) {
      const fulfillmentOrdersRes = await axios.get(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}/fulfillment_orders.json`,
        {
          headers: {
            "X-Shopify-Access-Token": TOKEN,
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
              "X-Shopify-Access-Token": TOKEN,
              "Content-Type": "application/json",
            },
          }
        );
      } else {
        console.log(`⚠️ No open fulfillment orders for order ${orderId}, skipping fulfillment.`);
      }
    }

    if (tag === "Completed") {
      // ✅ Fetch order total amount
      const orderDetailsRes = await axios.get(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}.json`,
        {
          headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json",
          },
        }
      );
    
      const order = orderDetailsRes.data.order;
      const amount = parseFloat(order.total_price);
    
      // ✅ Force manual transaction to mark as paid
      await axios.post(
        `https://cropndtop.myshopify.com/admin/api/2024-01/orders/${orderId}/transactions.json`,
        {
          transaction: {
            kind: "capture",       // use "capture" for consistency
            status: "success",     // must be "success"
            amount: amount,        // dynamic order amount
            gateway: "manual",     // required for manual (COD) payments
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": TOKEN,
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
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json",
        },
      });

      const orders = response.data.orders || [];
      allOrders.push(...orders);

      const linkHeader = response.headers.link;
      pageInfo = extractNextPageInfo(linkHeader);
    } while (pageInfo);

    const tagCounts = {};
    let totalOrders = allOrders.length;

    for (const order of allOrders) {
      const tags = (order.tags || "").split(",").map((t) => t.trim()).filter(t => t !== "");
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

// app.listen(3000, () => {
//   console.log("✅ Proxy running on http://localhost:3000");
// });
app.get('/api/unpaid-order-count', async (req, res) => {
  try {
    const response = await fetch('https://cropndtop.myshopify.com/admin/api/2024-01/orders/count.json?status=any&financial_status=pending', {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    res.json({ count: data.count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch unpaid order count' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});
