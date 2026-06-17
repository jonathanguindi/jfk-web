-- cobranzas-schema.sql
-- Ejecutar UNA VEZ en el SQL Editor de Supabase (cada proyecto: JFK y Big Dream).
-- Agrega el soporte para el módulo de cobranzas.

-- 1) Columnas en customers para la lista de envío automático ------------------
alter table public.customers
  add column if not exists cobranza_auto boolean not null default false;

alter table public.customers
  add column if not exists cobranza_last_sent timestamptz;

-- 2) Tabla de envíos / cola de aprobación -------------------------------------
create table if not exists public.cobranza_envios (
  id            uuid primary key default gen_random_uuid(),
  sap_card_code text not null,
  customer_name text,
  email         text,
  empresa       text,                       -- 'JFK' | 'BDB'
  saldo         numeric,
  vencido       numeric,
  atraso_dias   integer,
  cadencia      text,                        -- 'semanal' | 'diario'
  tipo          text default 'auto',         -- 'auto' | 'manual'
  status        text default 'pendiente',    -- 'pendiente' | 'enviado' | 'error' | 'descartado'
  error         text,
  message_id    text,
  approved_by   text,
  created_at    timestamptz default now(),
  sent_at       timestamptz
);

create index if not exists idx_cobranza_envios_status on public.cobranza_envios (status);
create index if not exists idx_cobranza_envios_card   on public.cobranza_envios (sap_card_code);
create index if not exists idx_cobranza_envios_created on public.cobranza_envios (created_at desc);

-- 3) RLS / permisos -----------------------------------------------------------
-- Las Netlify Functions usan la SERVICE KEY (omiten RLS), así que el job y el envío
-- funcionan sin políticas. El PORTAL (clave publishable/anon) necesita poder:
--   * leer la cola de pendientes,                (select)
--   * marcar/desmarcar clientes en la lista auto (update customers.cobranza_auto),
--   * descartar un pendiente.                    (update cobranza_envios.status)
--
-- Estas políticas son permisivas, coherentes con el modelo actual del portal
-- (la clave anon ya lee customers e inserta pedidos). Ajusta si endureces la seguridad.

alter table public.cobranza_envios enable row level security;

drop policy if exists cobranza_envios_anon_select on public.cobranza_envios;
create policy cobranza_envios_anon_select on public.cobranza_envios
  for select to anon using (true);

drop policy if exists cobranza_envios_anon_update on public.cobranza_envios;
create policy cobranza_envios_anon_update on public.cobranza_envios
  for update to anon using (true) with check (true);

-- Si customers tiene RLS activado y la anon NO puede actualizar cobranza_auto,
-- descomenta una política como esta (ya debería poder leer customers):
-- drop policy if exists customers_anon_update_cobranza on public.customers;
-- create policy customers_anon_update_cobranza on public.customers
--   for update to anon using (true) with check (true);
