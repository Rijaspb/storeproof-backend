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
              i.incident_details, i.police_link, i.crime_reference, i.notes, i.created_at,
              coalesce((select json_agg(json_build_object('id', o.id, 'incident_number', o.incident_number)
                                        order by o.incident_number)
                          from public.incident_links l
                          join public.incidents o on o.id = case when l.incident_a = i.id then l.incident_b else l.incident_a end
                          where i.id in (l.incident_a, l.incident_b)), '[]') as linked_incidents,
              coalesce(
                json_agg(json_build_object(
                  'id', v.id, 'original_filename', v.original_filename,
                  'size_bytes', v.size_bytes, 'created_at', v.created_at
                ) order by v.created_at) filter (where v.id is not null),
                '[]'
              ) as videos
       from public.incidents i
       join public.stores s on s.id = i.store_id
       left join public.incident_videos v on v.incident_id = i.id and v.status = 'uploaded'
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
    if (incidentAt > new Date(Date.now() + 5 * 60 * 1000)) throw badRequest('incident_at cannot be in the future');

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
       returning i.id, i.incident_number, i.status, i.police_link, i.crime_reference`,
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

const MAX_CRIME_REFERENCE = 100;

router.patch(
  '/:id/crime-reference',
  updateIncident('crime_reference', ({ crime_reference }) => {
    const text = optionalText(crime_reference, 'crime_reference');
    if (text !== null && text.length > MAX_CRIME_REFERENCE) throw badRequest('crime_reference is too long');
    return text;
  }),
);

const linkParams = (req) => {
  const { id, otherId = req.body?.linked_incident_id } = req.params;
  if (!UUID.test(id)) throw Object.assign(new Error('Incident not found'), { status: 404 });
  if (typeof otherId !== 'string' || !UUID.test(otherId)) throw badRequest('linked_incident_id must be an incident id');
  if (id.toLowerCase() === otherId.toLowerCase()) throw badRequest('An incident cannot be linked to itself');
  return [id, req.userId, otherId];
};

// Links two incidents of the same store; each pair is stored once, so it shows on both
router.post('/:id/links', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `insert into public.incident_links (incident_a, incident_b)
       select least(a.id, b.id), greatest(a.id, b.id)
       from public.incidents a
       join public.stores s on s.id = a.store_id
       join public.incidents b on b.id = $3 and b.store_id = a.store_id
       where a.id = $1 and s.owner_id = $2
       on conflict (incident_a, incident_b) do update set incident_a = excluded.incident_a
       returning incident_a`,
      linkParams(req),
    );

    if (rows.length === 0) throw Object.assign(new Error('Incident not found'), { status: 404 });
    res.status(201).json({ linked: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/links/:otherId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `delete from public.incident_links l
       using public.incidents a, public.stores s
       where a.id = $1 and s.id = a.store_id and s.owner_id = $2
         and l.incident_a = least($1::uuid, $3::uuid) and l.incident_b = greatest($1::uuid, $3::uuid)
       returning l.incident_a`,
      linkParams(req),
    );

    if (rows.length === 0) throw Object.assign(new Error('Link not found'), { status: 404 });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
