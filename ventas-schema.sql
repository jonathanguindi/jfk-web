-- ventas-schema.sql · Dashboard de ventas JFK
-- Correr en el SQL Editor de Supabase (proyecto gpighopguwafnxouejfb).
-- Crea la tabla de hechos (una fila por línea de factura/nota de crédito),
-- el estado del sincronizador (cursor reanudable) y los RPC de agregación.

-- ───────────────────────────────────────────────────────────────────────────
-- 1) Tabla de hechos: una fila por línea de documento, ya denormalizada
--    (vendedor, país y familia de producto) para agregar sin joins.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists ventas_lineas (
  line_uid          text primary key,           -- doc_type|doc_entry|line_num (idempotente para upsert)
  doc_type          text not null,              -- 'I' factura · 'C' nota de crédito
  doc_entry         integer not null,
  doc_num           integer,
  doc_date          date not null,
  card_code         text not null,
  card_name         text,
  country_code      text,
  country_name      text,
  sales_person_code integer,
  sales_person_name text,
  item_code         text,
  item_description  text,
  item_group_code   integer,
  item_group_name   text,
  quantity          numeric default 0,
  line_total        numeric default 0,          -- USD; NEGATIVO en notas de crédito (resta ventas)
  updated_at        timestamptz default now()
);

create index if not exists idx_vl_doc_date  on ventas_lineas (doc_date);
create index if not exists idx_vl_sp         on ventas_lineas (sales_person_code);
create index if not exists idx_vl_country    on ventas_lineas (country_code);
create index if not exists idx_vl_card       on ventas_lineas (card_code);
create index if not exists idx_vl_item       on ventas_lineas (item_code);
create index if not exists idx_vl_group      on ventas_lineas (item_group_code);

-- ───────────────────────────────────────────────────────────────────────────
-- 1b) Ficha de cliente (datos de contacto desde BusinessPartners de SAP).
--     Se refresca en cada sincronización. Permite ver si el cliente tiene
--     correo/teléfono/dirección cargados en SAP.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists ventas_clientes (
  card_code      text primary key,
  card_name      text,
  email          text,
  phone1         text,
  phone2         text,
  cellular       text,
  address        text,
  city           text,
  country_code   text,
  country_name   text,
  contact_person text,
  sales_person_code integer,
  valid          text,            -- 'tYES'/'tNO' (activo en SAP)
  updated_at     timestamptz default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- 2) Estado del sincronizador (cursor por tipo de documento para reanudar).
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists ventas_sync_state (
  doc_type        text primary key,             -- 'I' | 'C'
  last_doc_entry  integer default 0,            -- último DocEntry procesado
  full_done       boolean default false,        -- ya alcanzó el final al menos una vez
  rows_total      integer default 0,
  updated_at      timestamptz default now()
);
insert into ventas_sync_state (doc_type) values ('I'), ('C')
  on conflict (doc_type) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) RPC: resumen agregado para el dashboard (un solo viaje, todo el JSON).
-- ───────────────────────────────────────────────────────────────────────────
create or replace function ventas_resumen(desde date, hasta date,
                                          p_vendedor integer default null,
                                          p_pais text default null)
returns jsonb
language sql stable
as $$
  with f as (
    select * from ventas_lineas
    where doc_date >= desde and doc_date <= hasta
      and (p_vendedor is null or sales_person_code = p_vendedor)
      and (p_pais is null or country_code = p_pais)
  ),
  total as (select coalesce(sum(line_total),0) as t from f)
  select jsonb_build_object(
    'periodo', jsonb_build_object('desde', desde, 'hasta', hasta),
    'kpis', (
      select jsonb_build_object(
        'ventas_total',     coalesce(sum(line_total),0),
        'num_documentos',   count(distinct (doc_type||doc_entry)),
        'num_clientes',     count(distinct card_code),
        'num_vendedores',   count(distinct sales_person_code),
        'num_paises',       count(distinct country_code),
        'num_productos',    count(distinct item_code),
        'ticket_promedio',  case when count(distinct (doc_type||doc_entry))>0
                              then coalesce(sum(line_total),0)/count(distinct (doc_type||doc_entry)) else 0 end
      ) from f
    ),
    'por_vendedor', coalesce((
      select jsonb_agg(x) from (
        select sales_person_code as code,
               coalesce(max(sales_person_name),'(sin vendedor)') as name,
               sum(line_total) as total,
               count(distinct card_code) as clientes,
               round(100*sum(line_total)/nullif((select t from total),0),1) as pct
        from f group by sales_person_code order by total desc
      ) x), '[]'::jsonb),
    'por_pais', coalesce((
      select jsonb_agg(x) from (
        select country_code as code,
               coalesce(max(country_name), country_code, '(sin país)') as name,
               sum(line_total) as total,
               count(distinct card_code) as clientes,
               round(100*sum(line_total)/nullif((select t from total),0),1) as pct
        from f group by country_code order by total desc
      ) x), '[]'::jsonb),
    'por_familia', coalesce((
      select jsonb_agg(x) from (
        select item_group_code as code,
               coalesce(max(item_group_name),'(sin familia)') as name,
               sum(line_total) as total,
               round(100*sum(line_total)/nullif((select t from total),0),1) as pct
        from f group by item_group_code order by total desc
      ) x), '[]'::jsonb),
    'por_producto', coalesce((
      select jsonb_agg(x) from (
        select item_code as code,
               coalesce(max(item_description),'') as descripcion,
               coalesce(max(item_group_name),'') as familia,
               sum(line_total) as total,
               sum(quantity) as qty,
               round(100*sum(line_total)/nullif((select t from total),0),1) as pct
        from f group by item_code order by total desc limit 80
      ) x), '[]'::jsonb),
    'por_cliente', coalesce((
      select jsonb_agg(x) from (
        select card_code,
               coalesce(max(card_name), card_code) as name,
               coalesce(max(country_name), max(country_code)) as pais,
               coalesce(max(sales_person_name),'') as vendedor,
               sum(line_total) as total,
               count(distinct (doc_type||doc_entry)) as documentos,
               max(doc_date) as ultima_compra
        from f group by card_code order by total desc limit 200
      ) x), '[]'::jsonb),
    'tendencia', coalesce((
      select jsonb_agg(x) from (
        select to_char(date_trunc('month', doc_date),'YYYY-MM') as mes,
               sum(line_total) as total
        from f group by 1 order by 1
      ) x), '[]'::jsonb)
  );
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4) RPC: detalle de un cliente (qué compra y cuánto, en el período).
-- ───────────────────────────────────────────────────────────────────────────
create or replace function ventas_cliente_detalle(p_card text, desde date, hasta date)
returns jsonb
language sql stable
as $$
  with f as (
    select * from ventas_lineas
    where card_code = p_card and doc_date >= desde and doc_date <= hasta
  )
  select jsonb_build_object(
    'card_code', p_card,
    'card_name', (select coalesce(max(card_name), p_card) from f),
    'pais',      (select coalesce(max(country_name), max(country_code)) from f),
    'vendedor',  (select coalesce(max(sales_person_name),'') from f),
    'total',     (select coalesce(sum(line_total),0) from f),
    'periodo',   jsonb_build_object('desde', desde, 'hasta', hasta),
    'contacto',  (select to_jsonb(c) from (
                    select card_name, email, phone1, phone2, cellular, address, city,
                           country_name, contact_person, valid
                    from ventas_clientes where card_code = p_card
                  ) c),
    'productos', coalesce((
      select jsonb_agg(x) from (
        select item_code as code,
               coalesce(max(item_description),'') as descripcion,
               coalesce(max(item_group_name),'') as familia,
               sum(quantity) as qty,
               sum(line_total) as total,
               count(distinct (doc_type||doc_entry)) as veces,
               max(doc_date) as ultima_compra
        from f group by item_code order by total desc
      ) x), '[]'::jsonb),
    'documentos', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'doc_type', doc_type, 'doc_num', doc_num, 'doc_date', doc_date,
                 'total', total, 'num_lineas', num_lineas, 'lineas', lineas
               ) order by doc_date desc, doc_num desc nulls last)
      from (
        select doc_type, doc_entry, doc_num, doc_date,
               sum(line_total) as total,
               count(*) as num_lineas,
               jsonb_agg(jsonb_build_object(
                 'code', item_code, 'descripcion', item_description,
                 'familia', item_group_name, 'qty', quantity, 'total', line_total
               ) order by line_total desc) as lineas
        from f
        group by doc_type, doc_entry, doc_num, doc_date
      ) docs
    ), '[]'::jsonb)
  );
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5) Plazas: asignación de un vendedor "dueño" por país (territorio).
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists ventas_plaza_pais (
  country_code      text primary key,
  country_name      text,
  sales_person_code integer,
  sales_person_name text,
  updated_at        timestamptz default now()
);

-- RPC: por país, ventas totales + desglose por vendedor (el de mayor venta = líder
--      = propuesta) + asignación manual actual. Para organizar las plazas.
create or replace function ventas_plazas(desde date, hasta date)
returns jsonb
language sql stable
as $$
  with f as (
    select * from ventas_lineas
    where doc_date >= desde and doc_date <= hasta and country_code is not null
  ),
  porpais as (
    select country_code, max(country_name) cn, sum(line_total) total, count(distinct card_code) clientes
    from f group by country_code
  )
  select coalesce(jsonb_agg(z order by (z->>'total')::numeric desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'code', p.country_code,
      'name', coalesce(p.cn, p.country_code),
      'total', p.total,
      'clientes', p.clientes,
      'asignado', (select to_jsonb(a) from (
                     select sales_person_code as code, sales_person_name as name
                     from ventas_plaza_pais where country_code = p.country_code
                   ) a),
      'vendedores', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'code', sales_person_code, 'name', coalesce(sales_person_name,'(sin vendedor)'),
                 'total', vt, 'clientes', vc,
                 'pct', round(100*vt/nullif(p.total,0),1)) order by vt desc)
        from (
          select sales_person_code, max(sales_person_name) sales_person_name,
                 sum(line_total) vt, count(distinct card_code) vc
          from f where country_code = p.country_code
          group by sales_person_code
        ) v
      ), '[]'::jsonb)
    ) z
    from porpais p
  ) zz;
$$;

-- Permitir que el rol de servicio (funciones Netlify) ejecute los RPC.
grant execute on function ventas_resumen(date, date, integer, text) to service_role;
grant execute on function ventas_cliente_detalle(text, date, date) to service_role;
grant execute on function ventas_plazas(date, date) to service_role;
