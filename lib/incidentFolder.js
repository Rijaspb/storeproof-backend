import db from '../db/index.js';

// Filesystem-safe ISO timestamp, e.g. 2026-10-05T13-30-00-000Z
export const stamp = (d) => new Date(d).toISOString().replace(/[:.]/g, '-');

// R2 has no real folders, so "creating" one is just using a key prefix. Reuse the prefix of any existing
// video/image of the incident so every upload lands in the same folder, even if incident_at changed since.
export const incidentFolder = async (incident) => {
  const { rows } = await db.query(
    `select regexp_replace(r2_key, '/[^/]*$', '') as prefix
     from (select r2_key, created_at from public.incident_videos where incident_id = $1
           union all select r2_key, created_at from public.incident_images where incident_id = $1) k
     order by created_at
     limit 1`,
    [incident.id],
  );
  const base = `stores/${incident.store_id}/incidents/`;
  const prefix = rows[0]?.prefix;
  return prefix?.startsWith(base) ? prefix : `${base}${stamp(incident.incident_at).slice(0, 16)}_${incident.id}`;
};
