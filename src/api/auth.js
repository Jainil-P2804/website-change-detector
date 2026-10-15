'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const prisma = require('../db');
const config = require('../config');

const credentials = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(10).max(200),
});

const newApiToken = () => crypto.randomBytes(24).toString('base64url');
const issue = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '7d' });

async function register(req, res) {
  const { email, password } = credentials.parse(req.body);
  if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: 'Email already registered' });
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 12),
      apiToken: newApiToken(),
      alertSettings: { create: {} },
    },
  });
  res.status(201).json({ token: issue(user), apiToken: user.apiToken });
}

async function login(req, res) {
  const { email, password } = credentials.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: issue(user), apiToken: user.apiToken });
}

/** Accepts `Authorization: Bearer <jwt>` (dashboard) or `X-API-Token: <token>` (browser extension). */
async function requireAuth(req, res, next) {
  try {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const apiToken = req.headers['x-api-token'];
    let user = null;
    if (bearer) {
      const { sub } = jwt.verify(bearer, config.jwtSecret);
      user = await prisma.user.findUnique({ where: { id: sub } });
    } else if (apiToken) {
      user = await prisma.user.findUnique({ where: { apiToken: String(apiToken) } });
    }
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/** Tiny fixed-window limiter for credential endpoints. Use Redis-backed limiting behind multiple API replicas. */
function windowLimiter({ max, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) hits.set(key, { start: now, n: 1 });
    else if (++entry.n > max) return res.status(429).json({ error: 'Too many requests' });
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

module.exports = { register, login, requireAuth, windowLimiter };
