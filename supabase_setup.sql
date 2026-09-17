-- MEDIROUTE SUPABASE DATABASE SETUP
-- Run this complete file in Supabase: SQL Editor -> New query -> Run

create table if not exists public.orders (
  id text primary key,
  room text not null,
  items jsonb not null default '[]'::jsonb,
  medicine text,
  quantity integer,
  unit text,
  priority text not null default 'Normal',
  notes text not null default '',
  status text not null default 'Pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb
);

alter table public.orders enable row level security;

drop policy if exists "prototype_read_orders" on public.orders;
drop policy if exists "prototype_insert_orders" on public.orders;
drop policy if exists "prototype_update_orders" on public.orders;
drop policy if exists "prototype_delete_orders" on public.orders;

create policy "prototype_read_orders"
on public.orders for select
to anon, authenticated
using (true);

create policy "prototype_insert_orders"
on public.orders for insert
to anon, authenticated
with check (true);

create policy "prototype_update_orders"
on public.orders for update
to anon, authenticated
using (true)
with check (true);

create policy "prototype_delete_orders"
on public.orders for delete
to anon, authenticated
using (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.orders to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
end
$$;
