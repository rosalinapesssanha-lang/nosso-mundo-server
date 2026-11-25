-- Execute no Supabase > SQL Editor > New query.
-- Fila persistente de ensinamentos/pensamentos do Nosso Mundo.
create table if not exists public.game_thought_queue (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.game_worlds(id) on delete cascade,
  user_id uuid not null references public.game_users(id) on delete cascade,
  input_text text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  progress integer not null default 0 check (progress between 0 and 100),
  stage text not null default 'Na fila',
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists game_thought_queue_world_created_idx
  on public.game_thought_queue(world_id, created_at desc);
create index if not exists game_thought_queue_status_created_idx
  on public.game_thought_queue(status, created_at asc);

alter table public.game_thought_queue enable row level security;
