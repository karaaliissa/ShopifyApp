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

// ✅ This must be before any route that expects JSON body
app.use(bodyParser.json());

// ✅ LOGIN route — now it will correctly parse body!
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (username !== process.env.ADMIN_USERNAME)
    return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

// ✅ CONFIG
const API_SECRET = process.env.API_SECRET || 'your-very-strong-secret-token';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map(ip => ip.trim());

// ✅ CORS — only allow frontend origin
app.use(cors({
  origin: ['https://karaaliissa.github.io'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-App-Token', 'Authorization']
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

// ✅ Middleware: Token Authentication (App token)
app.use('/api/', (req, res, next) => {
  const token = req.headers['x-app-token'];
  if (token !== API_SECRET) {
    return res.status(403).json({ error: 'Forbidden - Invalid token' });
  }
  next();
});

// ✅ Middleware: JWT Authentication (Admin login)
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
