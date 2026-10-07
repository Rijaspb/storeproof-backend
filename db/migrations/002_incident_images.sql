-- Run once in the Supabase SQL editor. Up to 2 images per incident (slot 1 and 2), independent of videos.
create table public.incident_images (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  slot smallint not null check (slot in (1, 2)),
  r2_key text not null unique,
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  status text not null default 'pending' check (status in ('pending', 'uploaded')),
  -- A replacement upload for an already uploaded slot waits here; the current image stays until it completes
  pending_r2_key text unique,
  pending_filename text,
  pending_content_type text,
  pending_size_bytes bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (incident_id, slot)
);

-- No policies: only the backend (direct DB connection) accesses this table, never the Supabase API
alter table public.incident_images enable row level security;
