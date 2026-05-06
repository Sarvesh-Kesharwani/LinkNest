create extension if not exists pgcrypto;

create table if not exists public.saved_links (
  id uuid primary key default gen_random_uuid(),
  sender_id bigint not null,
  sender_username text,
  chat_id bigint not null,
  platform text not null check (platform in ('instagram', 'youtube', 'webpage', 'unknown')),
  original_url text not null,
  canonical_url text not null,
  note text,
  note_status text not null default 'pending' check (note_status in ('pending', 'added', 'skipped')),
  telegram_message_id bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sender_id, canonical_url)
);

alter table public.saved_links enable row level security;

grant usage on schema public to anon;
grant select, insert, update on public.saved_links to anon;

drop policy if exists saved_links_bot_select on public.saved_links;
create policy saved_links_bot_select
on public.saved_links
for select
to anon
using (true);

drop policy if exists saved_links_bot_insert on public.saved_links;
create policy saved_links_bot_insert
on public.saved_links
for insert
to anon
with check (true);

drop policy if exists saved_links_bot_update on public.saved_links;
create policy saved_links_bot_update
on public.saved_links
for update
to anon
using (true)
with check (true);

create index if not exists saved_links_sender_created_idx
  on public.saved_links (sender_id, created_at desc);

create index if not exists saved_links_platform_created_idx
  on public.saved_links (platform, created_at desc);

create index if not exists saved_links_note_search_idx
  on public.saved_links using gin (
    to_tsvector('simple', coalesce(note, '') || ' ' || canonical_url)
  );

create or replace function public.set_saved_links_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists saved_links_set_updated_at on public.saved_links;

create trigger saved_links_set_updated_at
before update on public.saved_links
for each row
execute function public.set_saved_links_updated_at();
