const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const { URL } = require("url");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// ✅ CONFIG
const API_SECRET = process.env.API_SECRET || 'your-very-strong-secret-token';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map(ip => ip.trim());

// ✅ CORS — production frontend only
app.use(cors({
  origin: ['https://karaaliissa.github.io'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-App-Token']
}));

// ✅ Rate Limiting
app.use('/api/', rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50
}));

// ✅ Middleware: IP Allowlist
app.use('/api/', (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (ALLOWED_IPS.length && !ALLOWED_IPS.includes(ip)) {
    console.warn(`🚨 Blocked IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden - IP not allowed' });
  }
  next();
});

// ✅ Middleware: Token Authentication
app.use('/api/', (req, res, next) => {
  const token = req.headers['x-app-token'];
  if (token !== API_SECRET) {
    return res.status(403).json({ error: 'Forbidden - Invalid token' });
  }
  next();
});
