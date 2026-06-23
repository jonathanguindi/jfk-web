-- cxp-schema.sql · Revisión de Cuentas por Pagar (facturas de compra abiertas en SAP).
-- Vuelca el snapshot de facturas NO cerradas para que el admin marque cuáles dejar activas
-- y cuáles cerrar (con nota). NO toca SAP: solo guarda la decisión aquí.
-- Correr UNA vez en el SQL Editor de Supabase de CADA empresa (JFK y Big Dream).

create table if not exists public.cxp_revision (
  doc_entry    bigint primary key,         -- id único de la factura en SAP
  doc_num      bigint,
  card_code    text,
  proveedor    text,
  fecha        date,
  vence        date,
  saldo        numeric default 0,
  atraso       integer default 0,          -- días vencido (positivo = ya venció)
  anio         integer,
  vigente      boolean default false,      -- emitida en los últimos ~18 meses
  moneda       text,
  decision     text,                       -- null = pendiente | 'activa' | 'cerrar'
  nota         text,
  decision_por text,
  decision_at  timestamptz,
  synced_at    timestamptz default now()
);
create index if not exists idx_cxp_decision on public.cxp_revision (decision);
create index if not exists idx_cxp_atraso   on public.cxp_revision (atraso desc);
create index if not exists idx_cxp_vigente  on public.cxp_revision (vigente);

-- Solo el backend (service key) accede; el anon key NO debe leer/escribir esta tabla.
alter table public.cxp_revision enable row level security;
