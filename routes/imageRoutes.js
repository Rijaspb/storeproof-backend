import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db/index.js';
import requireAuth from '../middleware/requireAuth.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { stamp, incidentFolder } from '../lib/incidentFolder.js';
import { presignUpload, presignDownload, headObject, deleteObject, UPLOAD_EXPIRES_SECONDS, DOWNLOAD_EXPIRES_SECONDS } from '../lib/r2.js';

// Mounted at /incidents/:incidentId/images. Each incident has two image slots (1 and 2), uploaded independently of videos
const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(createLimiter({ windowMs: 15 * 60 * 1000, limit: 120, keyGenerator: (req) => req.userId }));

const CONTENT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 20 * 1024 ** 2; // 20 MB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// The incident, only if its store belongs to the caller
const loadIncident = async (req) => {
  if (!UUID.test(req.params.incidentId)) throw httpError(404, 'Incident not found');
  const { rows } = await db.query(
    `select i.id, i.store_id, i.status, i.incident_at
     from public.incidents i join public.stores s on s.id = i.store_id
     where i.id = $1 and s.owner_id = $2`,
    [req.params.incidentId, req.userId],
  );
  if (rows.length === 0) throw httpError(404, 'Incident not found');
  return rows[0];
};

const loadSlot = async (req) => {
  const slot = Number(req.params.slot);
  if (![1, 2].includes(slot)) throw httpError(404, 'Image not found');
  return { incident: await loadIncident(req), slot };
};

const getImage = async (incidentId, slot) =>
  (await db.query(`select * from public.incident_images where incident_id = $1 and slot = $2`, [incidentId, slot])).rows[0];

router.get(
  '/',
  wrap(async (req, res) => {
    const incident = await loadIncident(req);
    const { rows } = await db.query(
      `select slot, original_filename, content_type, size_bytes, status, created_at
       from public.incident_images where incident_id = $1 order by slot`,
      [incident.id],
    );
    res.json({ items: rows });
  }),
);

router.post(
  '/:slot/init',
  wrap(async (req, res) => {
    const { incident, slot } = await loadSlot(req);
    const { filename, contentType, sizeBytes } = req.body ?? {};
    const name = typeof filename === 'string' ? filename.trim() : '';
    if (name.length < 1 || name.length > 255) throw httpError(400, 'filename must be 1-255 characters');
    if (typeof contentType !== 'string' || !Object.hasOwn(CONTENT_TYPES, contentType)) throw httpError(400, 'contentType is not allowed');
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_BYTES) throw httpError(400, `sizeBytes must be an integer between 1 and ${MAX_BYTES}`);
    if (incident.status !== 'pending') throw httpError(409, 'Incident is no longer accepting images');
    const old = await getImage(incident.id, slot);

    const key = `${await incidentFolder(incident)}/image${slot}_${stamp(Date.now())}_${randomUUID()}.${CONTENT_TYPES[contentType]}`;
    let stale; // superseded never-completed upload, safe to delete
    if (old?.status === 'uploaded') {
      // Replacement: the current image stays untouched until the new upload completes
      const { rowCount } = await db.query(
        `update public.incident_images
         set pending_r2_key = $2, pending_filename = $3, pending_content_type = $4, pending_size_bytes = $5, updated_at = now()
         where id = $1 and status = 'uploaded' and pending_r2_key is not distinct from $6`,
        [old.id, key, name, contentType, sizeBytes, old.pending_r2_key],
      );
      if (!rowCount) throw httpError(409, 'Image slot changed, try again');
      stale = old.pending_r2_key;
    } else {
      // First upload (or a retry of one): a retry just replaces the pending row
      const { rowCount } = await db.query(
        `insert into public.incident_images (incident_id, slot, r2_key, original_filename, content_type, size_bytes)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (incident_id, slot) do update
         set r2_key = excluded.r2_key, original_filename = excluded.original_filename, content_type = excluded.content_type,
             size_bytes = excluded.size_bytes, updated_at = now()
         where public.incident_images.status = 'pending'`,
        [incident.id, slot, key, name, contentType, sizeBytes],
      );
      // 0 rows means /complete filled the slot after we read it; deleting "stale" would destroy that image
      if (!rowCount) throw httpError(409, 'Image slot changed, try again');
      stale = old?.r2_key;
    }
    if (stale) await deleteObject(stale).catch((err) => console.error('Stale image delete failed:', err.message));
    const uploadUrl = await presignUpload(key, contentType, sizeBytes);
    res.status(201).json({ uploadUrl, expiresInSeconds: UPLOAD_EXPIRES_SECONDS });
  }),
);

router.post(
  '/:slot/complete',
  wrap(async (req, res) => {
    const { incident, slot } = await loadSlot(req);
    const row = await getImage(incident.id, slot);
    if (!row) throw httpError(404, 'Image not found');
    const replacing = row.pending_r2_key !== null;
    if (row.status === 'uploaded' && !replacing) return res.json({ slot, status: 'uploaded' });
    // Uploads older than 12h belong to the cleanup job (which waits 24h), so the two can never race on a row
    if (Date.now() - new Date(row.updated_at).getTime() > 12 * 60 * 60 * 1000) throw httpError(409, 'Upload expired, please upload again');

    const key = replacing ? row.pending_r2_key : row.r2_key;
    const size = Number(replacing ? row.pending_size_bytes : row.size_bytes);
    const type = replacing ? row.pending_content_type : row.content_type;
    const head = await headObject(key);
    if (!head) throw httpError(409, 'Upload not found');
    if (head.contentLength !== size || head.contentType?.toLowerCase() !== type) {
      await deleteObject(key);
      if (replacing) {
        await db.query(
          `update public.incident_images set pending_r2_key = null, pending_filename = null, pending_content_type = null,
             pending_size_bytes = null, updated_at = now() where id = $1 and pending_r2_key = $2`,
          [row.id, key],
        );
      }
      throw httpError(422, 'Uploaded file does not match what was approved');
    }
    // Swap in the new image only now that it is verified, then drop the old object
    const { rowCount } = await db.query(
      `update public.incident_images
       set r2_key = $2, original_filename = $3, content_type = $4, size_bytes = $5, status = 'uploaded', updated_at = now(),
           pending_r2_key = null, pending_filename = null, pending_content_type = null, pending_size_bytes = null
       where id = $1 and (pending_r2_key = $2 or (pending_r2_key is null and r2_key = $2))`,
      [row.id, key, replacing ? row.pending_filename : row.original_filename, type, size],
    );
    if (!rowCount) throw httpError(409, 'Image slot changed, try again');
    if (replacing) await deleteObject(row.r2_key).catch((err) => console.error('Old image delete failed:', err.message));
    res.json({ slot, status: 'uploaded' });
  }),
);

router.get(
  '/:slot/url',
  wrap(async (req, res) => {
    const { incident, slot } = await loadSlot(req);
    const row = await getImage(incident.id, slot);
    if (row?.status !== 'uploaded') throw httpError(404, 'Image not found');
    res.json({ url: await presignDownload(row.r2_key, row.original_filename), expiresInSeconds: DOWNLOAD_EXPIRES_SECONDS });
  }),
);

export default router;
