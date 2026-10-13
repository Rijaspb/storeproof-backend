-- Run once in the Supabase SQL editor. Each incident can point to one other incident ("Linked to").
alter table public.incidents
  add column linked_incident_id uuid references public.incidents(id) on delete set null,
  add constraint incidents_no_self_link check (linked_incident_id <> id);

create index on public.incidents (linked_incident_id);
