import { Router } from 'express';
import db from '../db/index.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

// The caller's own store, looked up by the verified user id
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `select id, store_name, incident_count, created_at
       from public.stores
       where owner_id = $1`,
      [req.userId],
    );

    if (rows.length === 0) throw Object.assign(new Error('Store not found'), { status: 404 });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
