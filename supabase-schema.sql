create extension if not exists pgcrypto;

create table if not exists public.saved_links (
  id uuid primary key default gen_random_uuid(),
  sender_id bigint not null,
  sender_username text,
  chat_id bigint not null,
  platform text not null check (platform in ('instagram', 'youtube', 'unknown')),
  original_url text not null,
  canonical_url text not null,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  unique (sender_id, canonical_url)
);

alter table public.saved_links enable row level security;

create index if not exists saved_links_sender_created_idx
  on public.saved_links (sender_id, created_at desc);

create index if not exists saved_links_platform_created_idx
  on public.saved_links (platform, created_at desc);
