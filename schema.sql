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

-- ============ Acesso familiar (v3): 1 titular + 1 familiar por conta ============
create table if not exists public.app_share (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint app_share_no_self check (owner_id <> member_id)
);
alter table public.app_share enable row level security;

drop policy if exists "owner gerencia share" on public.app_share;
create policy "owner gerencia share" on public.app_share
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "member le share" on public.app_share;
create policy "member le share" on public.app_share
  for select using (auth.uid() = member_id);

-- familiar pode ler/gravar o orçamento do titular
drop policy if exists "member le compartilhado" on public.app_state;
create policy "member le compartilhado" on public.app_state
  for select using (exists (select 1 from public.app_share s where s.owner_id = app_state.user_id and s.member_id = auth.uid()));
drop policy if exists "member grava compartilhado" on public.app_state;
create policy "member grava compartilhado" on public.app_state
  for update using (exists (select 1 from public.app_share s where s.owner_id = app_state.user_id and s.member_id = auth.uid()))
  with check (exists (select 1 from public.app_share s where s.owner_id = app_state.user_id and s.member_id = auth.uid()));
drop policy if exists "member insere compartilhado" on public.app_state;
create policy "member insere compartilhado" on public.app_state
  for insert with check (exists (select 1 from public.app_share s where s.owner_id = app_state.user_id and s.member_id = auth.uid()));

-- funções (security definer) usadas pelo app
create or replace function public.share_budget(p_email text) returns text
language plpgsql security definer set search_path = public, auth as $$
declare v_member uuid;
begin
  if auth.uid() is null then return 'unauthorized'; end if;
  select id into v_member from auth.users where lower(email) = lower(trim(p_email));
  if v_member is null then return 'not_found'; end if;
  if v_member = auth.uid() then return 'self'; end if;
  if exists (select 1 from public.app_share where member_id = v_member or owner_id = v_member) then return 'busy'; end if;
  if exists (select 1 from public.app_share where member_id = auth.uid()) then return 'in_share'; end if;
  insert into public.app_share(owner_id, member_id) values (auth.uid(), v_member)
    on conflict (owner_id) do update set member_id = excluded.member_id, created_at = now();
  return 'ok';
end $$;
revoke all on function public.share_budget(text) from public;
grant execute on function public.share_budget(text) to authenticated;

create or replace function public.unshare_budget() returns void
language sql security definer set search_path = public as $$
  delete from public.app_share where owner_id = auth.uid();
$$;
revoke all on function public.unshare_budget() from public;
grant execute on function public.unshare_budget() to authenticated;

create or replace function public.my_share() returns table(role text, other_email text, owner_id uuid)
language sql stable security definer set search_path = public, auth as $$
  select 'owner'::text, u.email::text, s.owner_id from public.app_share s join auth.users u on u.id = s.member_id where s.owner_id = auth.uid()
  union all
  select 'member'::text, u.email::text, s.owner_id from public.app_share s join auth.users u on u.id = s.owner_id where s.member_id = auth.uid();
$$;
revoke all on function public.my_share() from public;
grant execute on function public.my_share() to authenticated;

-- ============ LGPD: exclusão definitiva da própria conta ============
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  delete from auth.users where id = auth.uid(); -- cascata apaga app_state e app_share
end $$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- ============ Conectar banco (Meu Pluggy, opcional) ============
create table if not exists public.bank_link (
  user_id uuid primary key references auth.users(id) on delete cascade,
  client_id text not null,
  client_secret text not null,
  item_ids text[] not null default '{}',
  last_sync timestamptz,
  created_at timestamptz not null default now()
);
alter table public.bank_link enable row level security;
-- sem policies de acesso: apenas a Edge Function (service role) lê/escreve.
-- nem o próprio usuário (via API pública) nem o familiar enxergam os códigos.
