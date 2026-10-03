import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_MESSAGE = 5000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public endpoint, so cap it per IP: 5 messages per hour
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

const tooMany = (ip) => {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
};

// Drop expired entries so the map can't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(ip);
  }
}, WINDOW_MS).unref();

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const requiredText = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${name} is required`);
  const text = value.trim();
  if (text.length > max) throw badRequest(`${name} is too long`);
  return text;
};

router.post('/', async (req, res, next) => {
  try {
    const { name, email, message, website } = req.body ?? {};

    // Hidden field only bots fill in: pretend it worked and store nothing
    if (website) return res.status(201).json({ ok: true });

    if (tooMany(req.ip)) {
      throw Object.assign(new Error('Too many messages, please try again later'), {
        status: 429,
      });
    }

    const cleanEmail = requiredText(email, 'email', MAX_EMAIL);
    if (!EMAIL.test(cleanEmail)) throw badRequest('email must be valid');

    await db.query(
      `insert into public.contact_messages (name, email, message)
       values ($1, $2, $3)`,
      [
        requiredText(name, 'name', MAX_NAME),
        cleanEmail,
        requiredText(message, 'message', MAX_MESSAGE),
      ],
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
