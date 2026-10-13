import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import db from '../db/index.js';
import { stamp, incidentFolder } from '../lib/incidentFolder.js';
import requireAuth from '../middleware/requireAuth.js';
import { createLimiter } from '../middleware/rateLimit.js';
import {
  presignUpload,
  presignDownload,
  headObject,
  deleteObject,
  createMultipartUpload,
  presignUploadPart,
  completeMultipartUpload,
  UPLOAD_EXPIRES_SECONDS,
  DOWNLOAD_EXPIRES_SECONDS,
} from '../lib/r2.js';

// Mounted at /incidents/:incidentId/footage
const router = Router({ mergeParams: true });

router.use(requireAuth);

// Allowed video types and the object key extension for each; the extension never comes from the client
const CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
};
const MAX_UPLOAD_BYTES = 10 * 1024 ** 3; // 10 GB
// Files up to one part go in a single PUT; larger ones use multipart with fixed-size parts (R2 allows 10,000 parts)
const PART_SIZE = 64 * 1024 ** 2;
const MAX_PART_URLS = 50;
const MAX_FILENAME = 255;
const MAX_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Limiters key on the verified user (they run after requireAuth)
const perUser = (req) => req.userId;
const initLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 100,
  message: 'Too many uploads, please try again later',
  keyGenerator: perUser,
});
// Large files need many part URLs
const partsLimiter = createLimiter({ windowMs: 15 * 60 * 1000, limit: 600, keyGenerator: perUser });
const generalLimiter = createLimiter({ windowMs: 15 * 60 * 1000, limit: 120, keyGenerator: perUser });

const httpError = (status, message) => Object.assign(new Error(message), { status });
const notFound = () => httpError(404, 'Footage not found');
const incidentNotFound = () => httpError(404, 'Incident not found');

// Runs an R2 call; any failure becomes a 502 whose details only reach the server log
const r2 = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    throw Object.assign(new Error(`R2 ${err.name}: ${err.message}`), { status: 502 });
  }
};

// Passes errors on to the error handler; 5xx details are logged here with a request id and never sent
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.status && err.status < 500) return next(err);
    const requestId = randomUUID();
    console.error(`[footage ${requestId}] ${req.method} ${req.route?.path}:`, err.message);
    res.set('X-Request-Id', requestId);
    err.status ??= 500;
    next(err);
  }
};

const publicRow = (row) => ({
  id: row.id,
  incident_id: row.incident_id,
  original_filename: row.original_filename,
  content_type: row.content_type,
  size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
  status: row.status,
  created_at: row.created_at,
});

const COLUMNS = `f.id, f.incident_id, f.r2_key, f.upload_id, f.original_filename, f.content_type, f.size_bytes, f.status, f.created_at`;

// The incident (with its store id) only if its store belongs to the caller
const loadIncident = async (incidentId, userId) => {
  if (!UUID.test(incidentId)) throw incidentNotFound();
  const { rows } = await db.query(
    `select i.id, i.store_id, i.status, i.incident_at
     from public.incidents i
     join public.stores s on s.id = i.store_id
     where i.id = $1 and s.owner_id = $2`,
    [incidentId, userId],
  );
  if (rows.length === 0) throw incidentNotFound();
  return rows[0];
};

// Footage row only if it belongs to this incident and the incident's store belongs to the caller
const loadFootage = async (incidentId, footageId, userId) => {
  if (!UUID.test(incidentId) || !UUID.test(footageId)) throw notFound();
  const { rows } = await db.query(
    `select ${COLUMNS}
     from public.incident_videos f
     join public.incidents i on i.id = f.incident_id
     join public.stores s on s.id = i.store_id
     where f.id = $1 and f.incident_id = $2 and s.owner_id = $3`,
    [footageId, incidentId, userId],
  );
  if (rows.length === 0) throw notFound();
  return rows[0];
};

const partCountOf = (sizeBytes) => Math.ceil(Number(sizeBytes) / PART_SIZE);

const badRequest = (message) => httpError(400, message);

router.post(
  '/init',
  initLimiter,
  handle(async (req, res) => {
    const { filename, contentType, sizeBytes } = req.body ?? {};

    const name = typeof filename === 'string' ? filename.trim() : '';
    if (name.length < 1 || name.length > MAX_FILENAME) {
      throw badRequest(`filename must be 1-${MAX_FILENAME} characters`);
    }
    if (typeof contentType !== 'string' || !Object.hasOwn(CONTENT_TYPES, contentType)) {
      throw badRequest('contentType is not allowed');
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
      throw badRequest(`sizeBytes must be an integer between 1 and ${MAX_UPLOAD_BYTES}`);
    }

    // 404 whether the incident is missing or someone else's; storeId comes from the DB, never the client
    const incident = await loadIncident(req.params.incidentId, req.userId);
    if (incident.status !== 'pending') throw httpError(409, 'Incident is no longer accepting footage');

    // Folder is stamped with the incident time at first upload and reused after; files with their upload time
    const key = `${await incidentFolder(incident)}/${stamp(Date.now())}_${randomUUID()}.${CONTENT_TYPES[contentType]}`;
    const uploadId = sizeBytes > PART_SIZE ? await r2(() => createMultipartUpload(key, contentType)) : null;
    const { rows } = await db.query(
      `insert into public.incident_videos (incident_id, r2_key, original_filename, content_type, size_bytes, upload_id, status)
       values ($1, $2, $3, $4, $5, $6, 'pending')
       returning id`,
      [incident.id, key, name, contentType, sizeBytes, uploadId],
    );

    if (uploadId) {
      return res.status(201).json({
        footageId: rows[0].id,
        multipart: true,
        partSize: PART_SIZE,
        partCount: partCountOf(sizeBytes),
        expiresInSeconds: UPLOAD_EXPIRES_SECONDS,
      });
    }

    const uploadUrl = await r2(() => presignUpload(key, contentType, sizeBytes));
    res.status(201).json({
      footageId: rows[0].id,
      multipart: false,
      uploadUrl,
      expiresInSeconds: UPLOAD_EXPIRES_SECONDS,
    });
  }),
);

// Presigned URLs for the given part numbers (1-based). Each part must be sent exactly as sized here:
// PART_SIZE bytes, except the last part which is the remainder
router.post(
  '/:footageId/parts',
  partsLimiter,
  handle(async (req, res) => {
    const row = await loadFootage(req.params.incidentId, req.params.footageId, req.userId);
    if (row.status !== 'pending' || !row.upload_id) throw httpError(409, 'Footage is not awaiting parts');

    const total = Number(row.size_bytes);
    const partCount = partCountOf(total);
    const { partNumbers } = req.body ?? {};
    if (
      !Array.isArray(partNumbers) ||
      partNumbers.length < 1 ||
      partNumbers.length > MAX_PART_URLS ||
      !partNumbers.every((n) => Number.isInteger(n) && n >= 1 && n <= partCount) ||
      new Set(partNumbers).size !== partNumbers.length
    ) {
      throw badRequest(`partNumbers must be 1-${MAX_PART_URLS} unique integers between 1 and ${partCount}`);
    }

    const parts = await r2(() =>
      Promise.all(
        partNumbers.map(async (partNumber) => {
          const contentLength = partNumber < partCount ? PART_SIZE : total - PART_SIZE * (partCount - 1);
          const url = await presignUploadPart(row.r2_key, row.upload_id, partNumber, contentLength);
          return { partNumber, contentLength, url };
        }),
      ),
    );
    res.json({ parts, expiresInSeconds: UPLOAD_EXPIRES_SECONDS });
  }),
);

router.post(
  '/:footageId/complete',
  generalLimiter,
  handle(async (req, res) => {
    const row = await loadFootage(req.params.incidentId, req.params.footageId, req.userId);
    if (row.status === 'uploaded') return res.json(publicRow(row));
    if (row.status !== 'pending') throw httpError(409, 'Upload failed, start a new one');

    // Large files: stitch the uploaded parts together first. body: { parts: [{ partNumber, etag }] }
    if (row.upload_id) {
      const { parts } = req.body ?? {};
      const partCount = partCountOf(row.size_bytes);
      const valid =
        Array.isArray(parts) &&
        parts.length === partCount &&
        parts.every((p, i) => p?.partNumber === i + 1 && typeof p.etag === 'string' && p.etag.length <= 200);
      if (!valid) throw badRequest(`parts must list all ${partCount} parts in order, each with partNumber and etag`);

      try {
        await completeMultipartUpload(row.r2_key, row.upload_id, parts);
      } catch (err) {
        // NoSuchUpload: already completed by another call; the head check below decides
        if (['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'].includes(err.name)) {
          throw httpError(422, 'Uploaded parts are invalid');
        }
        if (err.name !== 'NoSuchUpload') throw Object.assign(new Error(`R2 ${err.name}: ${err.message}`), { status: 502 });
      }
    }

    const head = await r2(() => headObject(row.r2_key));
    if (!head) throw httpError(409, 'Upload not found');

    const sameType = head.contentType?.toLowerCase() === row.content_type;
    if (head.contentLength !== Number(row.size_bytes) || !sameType) {
      await db.query(
        `update public.incident_videos set status = 'failed', updated_at = now() where id = $1 and status = 'pending'`,
        [row.id],
      );
      await r2(() => deleteObject(row.r2_key));
      await db.query(`update public.incident_videos set r2_deleted_at = now() where id = $1`, [row.id]);
      throw httpError(422, 'Uploaded file does not match what was approved');
    }

    // Only one concurrent caller can flip pending -> uploaded
    const { rows } = await db.query(
      `update public.incident_videos f
       set status = 'uploaded', updated_at = now()
       where f.id = $1 and f.status = 'pending'
       returning ${COLUMNS}`,
      [row.id],
    );

    if (rows.length === 0) {
      const current = await loadFootage(req.params.incidentId, row.id, req.userId);
      if (current.status !== 'uploaded') throw httpError(409, 'Upload failed, start a new one');
      return res.json(publicRow(current));
    }

    // TODO: enqueue the BullMQ analysis job for rows[0].id here
    res.json(publicRow(rows[0]));
  }),
);

router.get(
  '/:footageId/url',
  generalLimiter,
  handle(async (req, res) => {
    const row = await loadFootage(req.params.incidentId, req.params.footageId, req.userId);
    if (row.status !== 'uploaded') throw httpError(409, 'Footage is not uploaded');

    const url = await r2(() => presignDownload(row.r2_key, row.original_filename));
    res.json({ url, expiresInSeconds: DOWNLOAD_EXPIRES_SECONDS });
  }),
);

// Newest first; limit max 50
router.get(
  '/',
  generalLimiter,
  handle(async (req, res) => {
    const incident = await loadIncident(req.params.incidentId, req.userId);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || MAX_PAGE, 1), MAX_PAGE);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await db.query(
      `select ${COLUMNS}
       from public.incident_videos f
       where f.incident_id = $1
       order by f.created_at desc
       limit $2 offset $3`,
      [incident.id, limit, offset],
    );
    res.json({ items: rows.map(publicRow), limit, offset });
  }),
);

export default router;
