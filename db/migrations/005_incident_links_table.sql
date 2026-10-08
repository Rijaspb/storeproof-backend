-- Run once in the Supabase SQL editor. Replaces the single linked_incident_id column (004) with a link table
-- so an incident can be linked to several others. Each pair is stored once (incident_a < incident_b).
alter table public.incidents drop column linked_incident_id;

create table public.incident_links (
  incident_a uuid not null references public.incidents(id) on delete cascade,
  incident_b uuid not null references public.incidents(id) on delete cascade,
  primary key (incident_a, incident_b),
  check (incident_a < incident_b)
);

create index on public.incident_links (incident_b);
alter table public.incident_links enable row level security;
