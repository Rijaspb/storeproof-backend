-- Run once in the Supabase SQL editor. Free-text crime reference number given by the police.
alter table public.incidents add column crime_reference text;
