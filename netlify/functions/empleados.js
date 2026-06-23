// empleados.js · Planilla/empleados (portal). Acciones: listar | guardar | eliminar. SOLO ADMIN.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === '' || v == null) ? null : (Number(v) || 0);

function aMensual(salary, frec) {
  const s = Number(salary) || 0;
  switch (frec) {
    case 'quincenal': return s * 2;
    case 'semanal': return s * 52 / 12;
    case 'anual': return s / 12;
    default: return s; // mensual
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const email = (body.email || '').trim().toLowerCase();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if (email !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const accion = body.accion || 'listar';

    if (accion === 'eliminar') {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return reply(200, { ok: false, error: 'id requerido' });
      const { error } = await sb.from('empleados').delete().eq('id', id);
      return reply(200, error ? { ok: false, error: error.message } : { ok: true });
    }

    if (accion === 'guardar') {
      const e = body.empleado || {};
      const fila = {
        nombre: e.nombre || null, cedula: e.cedula || null, cargo: e.cargo || null,
        salario: num(e.salario), frecuencia_pago: e.frecuencia_pago || 'mensual',
        fecha_ingreso: e.fecha_ingreso || null, tipo_contrato: e.tipo_contrato || 'indefinido',
        estado: e.estado || 'activo', email: e.email || null, telefono: e.telefono || null,
        nacionalidad: e.nacionalidad || null, domicilio: e.domicilio || null,
        fecha_nacimiento: e.fecha_nacimiento || null, funciones: e.funciones || null,
        dependientes: e.dependientes || null, representante: e.representante || null,
        nota: e.nota || null, creado_por: email
      };
      let res;
      if (e.id) res = await sb.from('empleados').update(fila).eq('id', Number(e.id));
      else res = await sb.from('empleados').insert(fila);
      return reply(200, res.error ? { ok: false, error: res.error.message } : { ok: true });
    }

    // listar
    const { data, error } = await sb.from('empleados').select('*').order('nombre', { ascending: true });
    if (error) return reply(200, { ok: false, error: error.message });
    const empleados = (data || []).map(e => ({ ...e, salario: r2(e.salario), salario_mensual: r2(aMensual(e.salario, e.frecuencia_pago)) }));
    const activos = empleados.filter(e => e.estado !== 'inactivo');
    const resumen = {
      total: empleados.length,
      activos: activos.length,
      planilla_mensual: r2(activos.reduce((s, e) => s + e.salario_mensual, 0)),
      planilla_anual: r2(activos.reduce((s, e) => s + e.salario_mensual, 0) * 12)
    };
    return reply(200, { ok: true, empresa: empresa.nombreCorto, resumen, empleados });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
