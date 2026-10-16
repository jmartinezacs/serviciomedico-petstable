-- =====================================================================
-- Servicio Médico · Pet's Table S.A. de C.V.
-- Migración 1/2: esquema, restricciones, índices y datos semilla.
-- Todos los objetos llevan el sufijo _med para aislarlos de otras apps
-- que comparten esta instancia de Supabase. No modifica objetos ajenos.
-- =====================================================================

-- ---------- Catálogo de áreas -----------------------------------------
create table if not exists public.areas_med (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null check (char_length(btrim(nombre)) between 2 and 80),
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists areas_med_nombre_uk on public.areas_med (lower(btrim(nombre)));

-- ---------- Usuarios autorizados del sistema ---------------------------
-- La autenticación es Supabase Auth (compartida); esta tabla define quién
-- puede entrar a ESTA app y con qué rol. Se vincula por correo.
create table if not exists public.usuarios_med (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email ~* '^[a-z0-9._%+-]+@petstable\.mx$'),
  nombre      text not null check (char_length(btrim(nombre)) between 2 and 120),
  area_id     uuid references public.areas_med(id) on delete restrict,
  rol         text not null default 'usuario' check (rol in ('admin','usuario')),
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists usuarios_med_email_uk on public.usuarios_med (lower(email));

-- ---------- Colaboradores (pacientes; no requieren cuenta) -------------
create table if not exists public.colaboradores_med (
  id            uuid primary key default gen_random_uuid(),
  num_empleado  text check (num_empleado is null or char_length(btrim(num_empleado)) between 1 and 30),
  nombre        text not null check (char_length(btrim(nombre)) between 3 and 120),
  area_id       uuid not null references public.areas_med(id) on delete restrict,
  puesto        text check (puesto is null or char_length(puesto) <= 100),
  activo        boolean not null default true,
  created_by    uuid references public.usuarios_med(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists colaboradores_med_num_uk on public.colaboradores_med (lower(btrim(num_empleado))) where num_empleado is not null;
create index if not exists colaboradores_med_area_idx on public.colaboradores_med (area_id);
create index if not exists colaboradores_med_nombre_idx on public.colaboradores_med (lower(nombre));

-- ---------- Configuración (fila única) --------------------------------
create table if not exists public.config_med (
  id                      smallint primary key default 1 check (id = 1),
  dias_alerta_caducidad   integer not null default 60 check (dias_alerta_caducidad between 1 and 365),
  updated_at              timestamptz not null default now()
);
insert into public.config_med (id) values (1) on conflict do nothing;

-- ---------- Citas -----------------------------------------------------
-- Horario: lunes a viernes, bloques de 30 min de 09:00 a 17:30
-- (último bloque inicia 17:00). Un solo consultorio: un bloque = una cita.
create table if not exists public.citas_med (
  id                    uuid primary key default gen_random_uuid(),
  folio                 bigint generated always as identity,
  colaborador_id        uuid not null references public.colaboradores_med(id) on delete restrict,
  fecha                 date not null,
  hora                  time not null,
  motivo                text not null check (motivo in ('consulta_general','malestar','curacion','seguimiento','toma_signos','otro')),
  descripcion           text check (descripcion is null or char_length(descripcion) <= 300),
  estado                text not null default 'pendiente' check (estado in ('pendiente','confirmada','atendida','cancelada','no_asistio')),
  solicitado_por        uuid not null references public.usuarios_med(id) on delete restrict,
  motivo_cancelacion    text check (motivo_cancelacion is null or char_length(motivo_cancelacion) <= 300),
  cancelado_por         uuid references public.usuarios_med(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint citas_med_dia_habil_ck check (extract(isodow from fecha) between 1 and 5),
  constraint citas_med_horario_ck  check (hora between time '09:00' and time '17:00' and extract(minute from hora) in (0,30) and extract(second from hora) = 0),
  constraint citas_med_cancelacion_ck check (estado <> 'cancelada' or motivo_cancelacion is not null)
);
create unique index if not exists citas_med_folio_uk on public.citas_med (folio);
-- Sin traslapes: un bloque solo puede tener una cita activa
create unique index if not exists citas_med_bloque_uk on public.citas_med (fecha, hora) where estado in ('pendiente','confirmada','atendida');
create index if not exists citas_med_fecha_idx on public.citas_med (fecha desc, hora);
create index if not exists citas_med_estado_idx on public.citas_med (estado);
create index if not exists citas_med_colab_idx on public.citas_med (colaborador_id);
create index if not exists citas_med_solicita_idx on public.citas_med (solicitado_por);

-- ---------- Atención (datos clínicos mínimos, solo administradores) ---
create table if not exists public.atenciones_med (
  cita_id         uuid primary key references public.citas_med(id) on delete restrict,
  sintomatologia  text check (sintomatologia is null or char_length(sintomatologia) <= 500),
  nota            text check (nota is null or char_length(nota) <= 1000),
  atendido_por    uuid not null references public.usuarios_med(id) on delete restrict,
  atendido_at     timestamptz not null default now()
);

-- ---------- Medicamentos ---------------------------------------------
create table if not exists public.medicamentos_med (
  id            uuid primary key default gen_random_uuid(),
  clave         text not null check (char_length(btrim(clave)) between 1 and 30),
  nombre        text not null check (char_length(btrim(nombre)) between 2 and 120),
  presentacion  text check (presentacion is null or char_length(presentacion) <= 120),
  unidad        text not null default 'pieza' check (char_length(btrim(unidad)) between 1 and 30),
  stock_minimo  integer not null default 0 check (stock_minimo >= 0),
  activo        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists medicamentos_med_clave_uk on public.medicamentos_med (lower(btrim(clave)));
create index if not exists medicamentos_med_nombre_idx on public.medicamentos_med (lower(nombre));

-- ---------- Lotes (existencia por lote y caducidad) --------------------
-- La existencia solo cambia mediante funciones de movimiento (sin escritura directa).
create table if not exists public.lotes_med (
  id              uuid primary key default gen_random_uuid(),
  medicamento_id  uuid not null references public.medicamentos_med(id) on delete restrict,
  lote            text not null check (char_length(btrim(lote)) between 1 and 40),
  caducidad       date not null,
  existencia      integer not null default 0 check (existencia >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists lotes_med_uk on public.lotes_med (medicamento_id, lower(btrim(lote)));
create index if not exists lotes_med_cad_idx on public.lotes_med (caducidad) where existencia > 0;

-- ---------- Movimientos de inventario (solo inserción) -----------------
create table if not exists public.movimientos_med (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('entrada','salida','ajuste','dispensacion')),
  medicamento_id  uuid not null references public.medicamentos_med(id) on delete restrict,
  lote_id         uuid not null references public.lotes_med(id) on delete restrict,
  cantidad        integer not null check (cantidad <> 0),   -- positiva suma, negativa resta
  existencia_resultante integer not null check (existencia_resultante >= 0),
  cita_id         uuid references public.citas_med(id) on delete restrict,
  motivo          text check (motivo is null or char_length(motivo) <= 300),
  usuario_id      uuid not null references public.usuarios_med(id) on delete restrict,
  created_at      timestamptz not null default now(),
  constraint movimientos_med_signo_ck check (
    (tipo = 'entrada' and cantidad > 0) or
    (tipo in ('salida','dispensacion') and cantidad < 0) or
    (tipo = 'ajuste')),
  constraint movimientos_med_dispensa_ck check ((tipo = 'dispensacion') = (cita_id is not null)),
  constraint movimientos_med_motivo_ck check (tipo not in ('salida','ajuste') or motivo is not null)
);
create index if not exists movimientos_med_fecha_idx on public.movimientos_med (created_at desc);
create index if not exists movimientos_med_med_idx on public.movimientos_med (medicamento_id);
create index if not exists movimientos_med_lote_idx on public.movimientos_med (lote_id);
create index if not exists movimientos_med_cita_idx on public.movimientos_med (cita_id) where cita_id is not null;
create index if not exists movimientos_med_usuario_idx on public.movimientos_med (usuario_id);

-- ---------- Bitácora de auditoría -------------------------------------
create table if not exists public.bitacora_med (
  id           bigint generated always as identity primary key,
  tabla        text not null,
  registro_id  text not null,
  accion       text not null check (accion in ('INSERT','UPDATE','DELETE')),
  cambios      jsonb,
  usuario_email text,
  created_at   timestamptz not null default now()
);
create index if not exists bitacora_med_fecha_idx on public.bitacora_med (created_at desc);
create index if not exists bitacora_med_tabla_idx on public.bitacora_med (tabla, registro_id);

-- ---------- Índices de llaves foráneas restantes ----------------------
create index if not exists usuarios_med_area_idx on public.usuarios_med (area_id);
create index if not exists colaboradores_med_created_by_idx on public.colaboradores_med (created_by);
create index if not exists citas_med_cancelado_por_idx on public.citas_med (cancelado_por);
create index if not exists atenciones_med_atendido_por_idx on public.atenciones_med (atendido_por);

-- ---------- RLS activado desde la creación (políticas en migración 2) --
alter table public.areas_med enable row level security;
alter table public.usuarios_med enable row level security;
alter table public.colaboradores_med enable row level security;
alter table public.config_med enable row level security;
alter table public.citas_med enable row level security;
alter table public.atenciones_med enable row level security;
alter table public.medicamentos_med enable row level security;
alter table public.lotes_med enable row level security;
alter table public.movimientos_med enable row level security;
alter table public.bitacora_med enable row level security;

-- ---------- Datos semilla proporcionados por el usuario ---------------
insert into public.areas_med (nombre) values
  ('Procesos y mejora continua'), ('Servicio médico'), ('Calidad')
on conflict do nothing;

insert into public.usuarios_med (email, nombre, area_id, rol)
select v.email, v.nombre, a.id, v.rol
from (values
  ('javier.martinez@petstable.mx', 'Javier Martínez',  'Procesos y mejora continua', 'admin'),
  ('kevin.hernandez@petstable.mx', 'Kevin Hernández',  'Procesos y mejora continua', 'admin'),
  ('nelisa.ramirez@petstable.mx',  'Nelisa Ramírez',   'Procesos y mejora continua', 'admin'),
  ('julian.pacheco@petstable.mx',  'Julián Pacheco',   'Procesos y mejora continua', 'admin'),
  ('servicio.medico@petstable.mx', 'Servicio Médico',  'Servicio médico',            'admin'),
  ('abigail.ordaz@petstable.mx',   'Abigail Ordaz',    'Calidad',                    'usuario')
) as v(email, nombre, area, rol)
join public.areas_med a on lower(a.nombre) = lower(v.area)
on conflict do nothing;
