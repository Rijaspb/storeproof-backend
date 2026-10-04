-- Run once in the Supabase SQL editor. Extends public.incident_videos for direct-to-R2 uploads.
-- Existing rows are treated as already uploaded; their new columns stay null.
alter table public.incident_videos
  add column original_filename text,
  add column content_type text,
  add column size_bytes bigint,
  add column upload_id text, -- set only for large files uploaded in parts
  add column status text not null default 'uploaded'
    check (status in ('pending', 'uploaded', 'failed')),
  add column updated_at timestamptz not null default now();

-- New rows are inserted as 'pending' by the backend
create index on public.incident_videos (status, created_at);
create unique index on public.incident_videos (r2_key);
