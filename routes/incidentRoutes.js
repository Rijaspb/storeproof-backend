import { Router } from 'express';
import db from '../db/index.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

// The pg connection bypasses RLS, so ownership is enforced in the query
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `select i.id, i.incident_number, i.incident_at, i.status, i.created_at
       from public.incidents i
       join public.stores s on s.id = i.store_id
       where s.owner_id = $1
       order by i.created_at desc`,
      [req.userId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Full details of one incident, only if it belongs to the caller's store
router.get('/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) {
      throw Object.assign(new Error('Incident not found'), { status: 404 });
    }

    const { rows } = await db.query(
      `select i.id, i.incident_number, i.incident_at, i.status, i.person_details,
              i.incident_details, i.police_link, i.notes, i.created_at,
              coalesce(
                json_agg(json_build_object(
                  'id', v.id, 'r2_key', v.r2_key, 'created_at', v.created_at
                ) order by v.created_at) filter (where v.id is not null),
                '[]'
              ) as videos
       from public.incidents i
       join public.stores s on s.id = i.store_id
       left join public.incident_videos v on v.incident_id = i.id
       where i.id = $1 and s.owner_id = $2
       group by i.id`,
      [req.params.id, req.userId],
    );

    if (rows.length === 0) throw Object.assign(new Error('Incident not found'), { status: 404 });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const MAX_TEXT = 5000;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// Optional text field: trimmed, empty becomes null
const optionalText = (value, name) => {
  if (value == null) return null;
  if (typeof value !== 'string') throw badRequest(`${name} must be text`);
  const text = value.trim();
  if (text.length > MAX_TEXT) throw badRequest(`${name} is too long`);
  return text || null;
};

router.post('/', async (req, res, next) => {
  try {
    const { incident_at, person_details, incident_details, notes } = req.body ?? {};

    const incidentAt = new Date(incident_at);
    if (typeof incident_at !== 'string' || Number.isNaN(incidentAt.getTime())) {
      throw badRequest('incident_at must be a valid date');
    }
    if (incidentAt > new Date()) throw badRequest('incident_at cannot be in the future');

    // store_id comes from the verified user, never from the request body
    const { rows } = await db.query(
      `insert into public.incidents (store_id, incident_at, person_details, incident_details, notes)
       select s.id, $2, $3, $4, $5
       from public.stores s
       where s.owner_id = $1
       returning id, incident_number, incident_at, status, created_at`,
      [
        req.userId,
        incidentAt,
        optionalText(person_details, 'person_details'),
        optionalText(incident_details, 'incident_details'),
        optionalText(notes, 'notes'),
      ],
    );

    if (rows.length === 0) throw Object.assign(new Error('Store not found'), { status: 404 });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const STATUSES = [
  'pending',
  'processing',
  'ready_to_upload',
  'uploaded_to_police',
  'ongoing_investigation',
  'finished',
  'failed',
];

const MAX_URL = 2048;

// Optional http(s) link: trimmed, empty/null clears it
const optionalUrl = (value, name) => {
  const text = optionalText(value, name);
  if (text === null) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw badRequest(`${name} must be a valid URL`);
  }
  if (text.length > MAX_URL || !['http:', 'https:'].includes(url.protocol)) {
    throw badRequest(`${name} must be a valid http(s) URL`);
  }
  return text;
};

// Updates one column of an incident the caller owns; column names are fixed in code, never user input
const updateIncident = (column, value) => async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) {
      throw Object.assign(new Error('Incident not found'), { status: 404 });
    }

    const { rows } = await db.query(
      `update public.incidents i
       set ${column} = $3
       from public.stores s
       where i.id = $1 and s.id = i.store_id and s.owner_id = $2
       returning i.id, i.incident_number, i.status, i.police_link`,
      [req.params.id, req.userId, value(req.body ?? {})],
    );

    if (rows.length === 0) throw Object.assign(new Error('Incident not found'), { status: 404 });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

router.patch(
  '/:id/status',
  updateIncident('status', ({ status }) => {
    if (!STATUSES.includes(status)) throw badRequest('status is invalid');
    return status;
  }),
);

router.patch(
  '/:id/police-link',
  updateIncident('police_link', ({ police_link }) => optionalUrl(police_link, 'police_link')),
);

export default router;
