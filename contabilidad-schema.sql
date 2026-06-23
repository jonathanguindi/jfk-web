-- contabilidad-schema.sql · Tablas del portal Contabilidad JFK (módulos nuevos).
-- Correr UNA vez en el SQL Editor de Supabase de CADA empresa (JFK y Big Dream).
-- Incluye: revisión de cuentas por pagar, préstamos, empleados y gastos.

-- 1) Revisión de cuentas por pagar (marcar facturas activa/cerrar)
create table if not exists public.cxp_revision (
  doc_entry bigint primary key, doc_num bigint, card_code text, proveedor text,
  fecha date, vence date, saldo numeric default 0, atraso integer default 0,
  anio integer, vigente boolean default false, moneda text,
  decision text, nota text, decision_por text, decision_at timestamptz,
  synced_at timestamptz default now()
);
alter table public.cxp_revision enable row level security;

-- 2) Préstamos / deuda bancaria
create table if not exists public.prestamos (
  id            bigint generated always as identity primary key,
  banco         text,
  descripcion   text,
  monto_original numeric default 0,
  saldo         numeric default 0,
  tasa          numeric,                 -- % anual
  cuota         numeric,                 -- pago periódico
  frecuencia    text default 'mensual',  -- mensual | quincenal | trimestral | unico
  moneda        text default 'USD',
  fecha_inicio  date,
  fecha_vencimiento date,                -- vencimiento final del préstamo
  proximo_pago  date,                    -- próxima cuota a pagar
  estado        text default 'activo',   -- activo | pagado
  nota          text,
  creado_por    text,
  creado_at     timestamptz default now()
);
alter table public.prestamos enable row level security;

-- 3) Empleados / planilla
create table if not exists public.empleados (
  id            bigint generated always as identity primary key,
  nombre        text,
  cedula        text,
  cargo         text,
  salario       numeric default 0,
  frecuencia_pago text default 'mensual',
  fecha_ingreso date,
  tipo_contrato text default 'indefinido',
  estado        text default 'activo',   -- activo | inactivo
  email         text,
  telefono      text,
  nota          text,
  creado_por    text,
  creado_at     timestamptz default now()
);
alter table public.empleados enable row level security;

-- 4) Gastos (luego se cargan también a SAP)
create table if not exists public.gastos (
  id            bigint generated always as identity primary key,
  fecha         date,
  categoria     text,
  descripcion   text,
  monto         numeric default 0,
  proveedor     text,
  moneda        text default 'USD',
  sap_doc_entry bigint,                  -- si ya se cargó a SAP
  estado        text default 'registrado',
  creado_por    text,
  creado_at     timestamptz default now()
);
alter table public.gastos enable row level security;

-- Columnas extra para el contrato automático (correr si ya tenías 'empleados'):
alter table public.empleados
  add column if not exists nacionalidad text,
  add column if not exists domicilio text,
  add column if not exists fecha_nacimiento date,
  add column if not exists funciones text,
  add column if not exists dependientes text,
  add column if not exists representante text;
