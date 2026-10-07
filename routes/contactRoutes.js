import { Router } from 'express';
import db from '../db/index.js';
import { contactLimiter } from '../middleware/rateLimit.js';

const router = Router();

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_MESSAGE = 5000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const requiredText = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${name} is required`);
  const text = value.trim();
  if (text.length > max) throw badRequest(`${name} is too long`);
  return text;
};

router.post('/', contactLimiter, async (req, res, next) => {
  try {
    const { name, email, message, website } = req.body ?? {};

    // Hidden field only bots fill in: pretend it worked and store nothing
    if (website) return res.status(201).json({ ok: true });

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
