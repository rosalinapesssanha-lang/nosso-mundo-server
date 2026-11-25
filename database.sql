-- Execute este SQL no Supabase > SQL Editor > New query.
-- Estas tabelas são próprias do jogo e não usam o Supabase Auth.
create extension if not exists pgcrypto;

create table if not exists public.game_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.game_worlds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_by uuid not null references public.game_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.game_world_members (
  world_id uuid not null references public.game_worlds(id) on delete cascade,
  user_id uuid not null references public.game_users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (world_id, user_id)
);

create table if not exists public.game_characters (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references public.game_users(id) on delete cascade,
  name text not null,
  animal text not null check (animal in ('urso','pinguim','capivara','panda')),
  personality text not null default '',
  energy integer not null default 100 check (energy between 0 and 100),
  social integer not null default 50 check (social between 0 and 100),
  position jsonb not null default '{"x":120,"y":120}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.game_events (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.game_worlds(id) on delete cascade,
  actor_user_id uuid references public.game_users(id) on delete set null,
  description text not null,
  created_at timestamptz not null default now()
);

create index if not exists game_world_members_user_idx on public.game_world_members(user_id);
create index if not exists game_events_world_created_idx on public.game_events(world_id, created_at desc);

-- As tabelas não ficam acessíveis diretamente pelo navegador.
-- O servidor usa a chave service_role guardada somente no Render.
alter table public.game_users enable row level security;
alter table public.game_worlds enable row level security;
alter table public.game_world_members enable row level security;
alter table public.game_characters enable row level security;
alter table public.game_events enable row level security;
