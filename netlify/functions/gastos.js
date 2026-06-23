// gastos.js · Gastos de la empresa (portal). Acciones: listar | guardar | eliminar. SOLO ADMIN.
// Alimenta la ganancia neta. (Postear a SAP se hará en un paso aparte cuando se defina la cuenta.)
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === '' || v == null) ? null : (Number(v) || 0);

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
      const { error } = await sb.from('gastos').delete().eq('id', id);
      return reply(200, error ? { ok: false, error: error.message } : { ok: true });
    }

    if (accion === 'guardar') {
      const g = body.gasto || {};
      const fila = {
        fecha: g.fecha || null, categoria: g.categoria || null, descripcion: g.descripcion || null,
        monto: num(g.monto), proveedor: g.proveedor || null, proveedor_codigo: g.proveedor_codigo || null,
        cuenta_gasto: g.cuenta_gasto || null, moneda: g.moneda || 'USD',
        estado: g.estado || 'registrado', creado_por: email
      };
      let res;
      if (g.id) res = await sb.from('gastos').update(fila).eq('id', Number(g.id));
      else res = await sb.from('gastos').insert(fila);
      return reply(200, res.error ? { ok: false, error: res.error.message } : { ok: true });
    }

    // listar (opcional: filtrar por rango)
    let q = sb.from('gastos').select('*').order('fecha', { ascending: false });
    if (body.desde) q = q.gte('fecha', body.desde);
    if (body.hasta) q = q.lte('fecha', body.hasta);
    const { data, error } = await q;
    if (error) return reply(200, { ok: false, error: error.message });
    const gastos = (data || []).map(g => ({ ...g, monto: r2(g.monto) }));
    const total = gastos.reduce((s, g) => s + (Number(g.monto) || 0), 0);
    const porCat = {};
    gastos.forEach(g => { const k = g.categoria || 'Sin categoría'; porCat[k] = (porCat[k] || 0) + (Number(g.monto) || 0); });
    const por_categoria = Object.entries(porCat).map(([categoria, monto]) => ({ categoria, monto: r2(monto) })).sort((a, b) => b.monto - a.monto);
    return reply(200, { ok: true, empresa: empresa.nombreCorto, resumen: { total: r2(total), num: gastos.length, por_categoria }, gastos });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
