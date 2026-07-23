-- Sobra: estado do app por usuário (1 linha jsonb por usuário)
create table if not exists public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "select proprio" on public.app_state;
drop policy if exists "insert proprio" on public.app_state;
drop policy if exists "update proprio" on public.app_state;

create policy "select proprio" on public.app_state
  for select using (auth.uid() = user_id);
create policy "insert proprio" on public.app_state
  for insert with check (auth.uid() = user_id);
create policy "update proprio" on public.app_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
