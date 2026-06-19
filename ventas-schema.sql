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
drop function if exists ventas_resumen(date, date, integer, text);
create or replace function ventas_resumen(desde date, hasta date,
                                          p_vendedores integer[] default null,
                                          p_pais text default null)
returns jsonb
language sql stable
as $$
  with f as (
    select * from ventas_lineas
    where doc_date >= desde and doc_date <= hasta
      and (p_vendedores is null or sales_person_code = any(p_vendedores))
      and (p_pais is null or country_code = p_pais)
  ),
  total as (select coalesce(sum(line_total),0) as t from f)
  select jsonb_build_object(
    'periodo', jsonb_build_object('desde', desde, 'hasta', hasta),
    'kpis', (
      select jsonb_build_object(
        'ventas_total',     coalesce(sum(line_total),0),
        -- Facturas y factura promedio SOLO sobre facturas (no notas de crédito).
        'num_facturas',     count(distinct doc_entry) filter (where doc_type='I'),
        'num_clientes',     count(distinct card_code),
        'num_vendedores',   count(distinct sales_person_code),
        'num_paises',       count(distinct country_code),
        'num_productos',    count(distinct item_code),
        'ticket_promedio',  case when count(distinct doc_entry) filter (where doc_type='I')>0
                              then coalesce(sum(line_total) filter (where doc_type='I'),0)/count(distinct doc_entry) filter (where doc_type='I') else 0 end
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
drop function if exists ventas_cliente_detalle(text, date, date);
create or replace function ventas_cliente_detalle(p_card text, desde date, hasta date,
                                                  p_vendedores integer[] default null)
returns jsonb
language sql stable
as $$
  with f as (
    select * from ventas_lineas
    where card_code = p_card and doc_date >= desde and doc_date <= hasta
      and (p_vendedores is null or sales_person_code = any(p_vendedores))
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

-- ───────────────────────────────────────────────────────────────────────────
-- 6) RPC: recomendaciones por cliente (Fase 3).
--    a) Reorden: productos que el cliente compra con cierto ritmo y que ya toca
--       reponer (días sin comprar >= ~0.75 × su cadencia histórica).
--    b) Cross-sell: productos que compran clientes parecidos (mismo país, dentro
--       del alcance) y que este cliente NO compra.
--    Usa los últimos 36 meses. p_vendedores = alcance (null = admin/todos).
-- ───────────────────────────────────────────────────────────────────────────
create or replace function ventas_recomendaciones(p_card text, p_vendedores integer[] default null)
returns jsonb
language sql stable
as $$
  with
  params as (select (current_date - interval '36 months')::date as d0),
  cli as (
    select vl.* from ventas_lineas vl, params p
    where vl.card_code = p_card and vl.doc_date >= p.d0
      and (p_vendedores is null or vl.sales_person_code = any(p_vendedores))
  ),
  cli_pais as (select max(country_code) cc from cli),
  -- Agrupar por PRODUCTO (descripción) para no duplicar ni diluir cuando un mismo
  -- producto tiene varios ItemCode.
  cli_prod as (
    select coalesce(nullif(trim(item_description),''), item_code) as prod,
           max(item_group_name) fam,
           count(distinct doc_date) veces, min(doc_date) f0, max(doc_date) f1,
           sum(line_total) total
    from cli where item_code is not null group by 1
  ),
  reorden as (
    select prod, fam, veces, f1, total,
           ((f1 - f0)::numeric / nullif(veces-1,0)) as cadencia,
           (current_date - f1) as dias_desde
    from cli_prod where veces >= 3        -- patrón confiable (>=3 compras)
  ),
  peers as (
    select distinct vl.card_code
    from ventas_lineas vl, params p
    where vl.doc_date >= p.d0 and vl.card_code <> p_card
      and vl.country_code = (select cc from cli_pais)
      and (p_vendedores is null or vl.sales_person_code = any(p_vendedores))
  ),
  peer_count as (select count(*) n from peers),
  peer_prod as (
    select coalesce(nullif(trim(vl.item_description),''), vl.item_code) as prod,
           max(vl.item_group_name) fam,
           count(distinct vl.card_code) peers_compran, sum(vl.line_total) total_peer
    from ventas_lineas vl, params p
    where vl.doc_date >= p.d0 and vl.item_code is not null
      and vl.card_code in (select card_code from peers)
      and (p_vendedores is null or vl.sales_person_code = any(p_vendedores))
    group by 1
  )
  select jsonb_build_object(
    'card_code', p_card,
    'pais', (select cc from cli_pais),
    'peers', (select n from peer_count),
    'reorden', coalesce((select jsonb_agg(x) from (
        select prod as descripcion, fam as familia, veces, total,
               round(cadencia) as cadencia_dias, dias_desde as dias_sin_comprar,
               round(dias_desde / nullif(cadencia,0), 2) as ratio
        from reorden
        -- cadencia real (>=14d, no ráfagas) y que toque ahora (no perdido hace mucho)
        where cadencia >= 14 and dias_desde >= cadencia*0.75 and dias_desde <= cadencia*3
        order by total desc
        limit 15
    ) x), '[]'::jsonb),
    'crosssell', coalesce((select jsonb_agg(x) from (
        select prod as descripcion, fam as familia, peers_compran, total_peer,
               round(100.0*peers_compran/nullif((select n from peer_count),0)) as pct_peers
        from peer_prod
        where prod not in (select prod from cli_prod)
        order by peers_compran desc, total_peer desc
        limit 12
    ) x), '[]'::jsonb)
  );
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7) RPC: comparativo producto × año (para país o vendedor o todo).
--    Devuelve { years:[...], productos:[{descripcion,familia,total,y:{anio:monto}}] }.
-- ───────────────────────────────────────────────────────────────────────────
drop function if exists ventas_comparativo(date, date, integer[], text);
create or replace function ventas_comparativo(desde date, hasta date,
                                              p_vendedores integer[] default null,
                                              p_pais text default null,
                                              p_card text default null)
returns jsonb
language sql stable
as $$
  with f as (
    select coalesce(nullif(trim(item_description),''), item_code) as prod,
           item_group_name as fam,
           to_char(date_trunc('year', doc_date),'YYYY') as anio,
           line_total
    from ventas_lineas
    where doc_date >= desde and doc_date <= hasta and item_code is not null
      and (p_vendedores is null or sales_person_code = any(p_vendedores))
      and (p_pais is null or country_code = p_pais)
      and (p_card is null or card_code = p_card)
  ),
  pa as (select prod, max(fam) fam, anio, sum(line_total) ytot from f group by prod, anio),
  byp as (
    select prod, max(fam) fam, sum(ytot) total, jsonb_object_agg(anio, ytot) as y
    from pa group by prod
  )
  select jsonb_build_object(
    'years', coalesce((select jsonb_agg(a order by a) from (select distinct anio a from f) s), '[]'::jsonb),
    'productos', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select prod as descripcion, fam as familia, total, y
        from byp order by total desc limit 60) x), '[]'::jsonb)
  );
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8) RPC: búsqueda de clientes (cualquiera, no solo el top) — server-side.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function ventas_buscar_clientes(q text, desde date, hasta date,
                                                  p_vendedores integer[] default null)
returns jsonb
language sql stable
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select card_code,
           coalesce(max(card_name), card_code) as name,
           coalesce(max(country_name), max(country_code)) as pais,
           coalesce(max(sales_person_name),'') as vendedor,
           sum(line_total) as total,
           count(distinct (doc_type||doc_entry)) as documentos,
           max(doc_date) as ultima_compra
    from ventas_lineas
    where doc_date >= desde and doc_date <= hasta
      and (p_vendedores is null or sales_person_code = any(p_vendedores))
      and (card_name ilike '%'||q||'%' or card_code ilike '%'||q||'%')
    group by card_code
    order by total desc
    limit 60
  ) x;
$$;

-- Permitir que el rol de servicio (funciones Netlify) ejecute los RPC.
grant execute on function ventas_comparativo(date, date, integer[], text, text) to service_role;
grant execute on function ventas_buscar_clientes(text, date, date, integer[]) to service_role;
grant execute on function ventas_resumen(date, date, integer[], text) to service_role;
grant execute on function ventas_cliente_detalle(text, date, date, integer[]) to service_role;
grant execute on function ventas_plazas(date, date) to service_role;
grant execute on function ventas_recomendaciones(text, integer[]) to service_role;
-- ───────────────────────────────────────────────────────────────────────────
-- RPC: clientes DORMIDOS (para reactivar).
-- Mira TODO el histórico (no un período): por cliente saca su última compra de
-- la vida, y devuelve los que llevan más de p_dias sin comprar.
--   p_dias       : umbral de inactividad en días (default 180 = 6 meses)
--   p_vendedores : null = todos (admin); o array de códigos SAP (alcance vendedor)
-- Ordena por "run-rate del último año activo" (lo que valía ese cliente al año),
-- así arriba salen los dormidos que más facturaban = mayor prioridad de rescate.
-- ───────────────────────────────────────────────────────────────────────────
drop function if exists ventas_dormidos(integer, integer[]);
create or replace function ventas_dormidos(p_dias integer default 180,
                                           p_vendedores integer[] default null)
returns jsonb
language sql stable
as $$
  with base as (
    select * from ventas_lineas
    where (p_vendedores is null or sales_person_code = any(p_vendedores))
  ),
  agg as (
    select card_code,
           coalesce(max(card_name), card_code)               as name,
           coalesce(max(country_name), max(country_code))     as pais,
           max(doc_date)                                      as ultima_compra,
           count(distinct (doc_type||doc_entry))              as n_compras,
           sum(line_total)                                    as total_hist
    from base group by card_code
  ),
  dorm as (
    select * from agg
    where ultima_compra < current_date - p_dias and total_hist > 0
  ),
  -- run-rate: ventas en los 365 días que terminan en su última compra
  ult as (
    select b.card_code, sum(b.line_total) as ult_ano
    from base b join dorm d on d.card_code = b.card_code
    where b.doc_date > d.ultima_compra - 365
    group by b.card_code
  ),
  -- vendedor de su última compra (a quién reasignar el rescate)
  vend as (
    select distinct on (b.card_code) b.card_code, b.sales_person_name as vendedor
    from base b join dorm d on d.card_code = b.card_code
    order by b.card_code, b.doc_date desc
  ),
  -- familia que más le compraba (por monto, histórico)
  fam as (
    select card_code, item_group_name from (
      select b.card_code, b.item_group_name, sum(b.line_total) s,
             row_number() over (partition by b.card_code order by sum(b.line_total) desc) rn
      from base b join dorm d on d.card_code = b.card_code
      where b.item_group_name is not null
      group by b.card_code, b.item_group_name
    ) z where rn = 1
  )
  select coalesce(jsonb_agg(x order by x.ult_ano desc nulls last), '[]'::jsonb) from (
    select d.card_code, d.name, d.pais,
           coalesce(v.vendedor,'')                  as vendedor,
           d.ultima_compra,
           (current_date - d.ultima_compra)         as dias,
           d.n_compras, d.total_hist,
           coalesce(u.ult_ano,0)                    as ult_ano,
           coalesce(f.item_group_name,'')           as top_familia,
           c.email,
           coalesce(c.cellular, c.phone1, c.phone2) as telefono,
           c.contact_person, c.city,
           (c.valid is not null and c.valid ~* 'NO') as inactivo_sap
    from dorm d
    left join ult  u on u.card_code = d.card_code
    left join vend v on v.card_code = d.card_code
    left join fam  f on f.card_code = d.card_code
    left join ventas_clientes c on c.card_code = d.card_code
  ) x;
$$;
