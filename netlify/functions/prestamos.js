// prestamos.js · Préstamos / deuda bancaria (portal). Acciones: listar | guardar | eliminar. SOLO ADMIN.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dias = (a, b) => Math.round((a - b) / 86400000);
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
      const { error } = await sb.from('prestamos').delete().eq('id', id);
      return reply(200, error ? { ok: false, error: error.message } : { ok: true });
    }

    if (accion === 'guardar') {
      const p = body.prestamo || {};
      const fila = {
        banco: p.banco || null, descripcion: p.descripcion || null,
        monto_original: num(p.monto_original), saldo: num(p.saldo),
        tasa: num(p.tasa), cuota: num(p.cuota),
        frecuencia: p.frecuencia || 'mensual', moneda: p.moneda || 'USD',
        fecha_inicio: p.fecha_inicio || null, fecha_vencimiento: p.fecha_vencimiento || null,
        proximo_pago: p.proximo_pago || null, estado: p.estado || 'activo',
        nota: p.nota || null, creado_por: email
      };
      let res;
      if (p.id) res = await sb.from('prestamos').update(fila).eq('id', Number(p.id));
      else res = await sb.from('prestamos').insert(fila);
      return reply(200, res.error ? { ok: false, error: res.error.message } : { ok: true });
    }

    // listar
    const { data, error } = await sb.from('prestamos').select('*').order('fecha_vencimiento', { ascending: true });
    if (error) return reply(200, { ok: false, error: error.message });
    const hoy = new Date();
    const prestamos = (data || []).map(p => {
      const venc = p.fecha_vencimiento ? new Date(p.fecha_vencimiento + 'T00:00:00') : null;
      const prox = p.proximo_pago ? new Date(p.proximo_pago + 'T00:00:00') : null;
      return {
        ...p,
        saldo: r2(p.saldo), monto_original: r2(p.monto_original), cuota: r2(p.cuota),
        dias_a_vencer: venc ? -dias(hoy, venc) : null,        // negativo = ya venció
        dias_proximo_pago: prox ? -dias(hoy, prox) : null
      };
    });
    const activos = prestamos.filter(p => p.estado !== 'pagado');
    const resumen = {
      deuda_total: r2(activos.reduce((s, p) => s + (Number(p.saldo) || 0), 0)),
      num_activos: activos.length,
      cuota_mensual: r2(activos.filter(p => p.frecuencia === 'mensual').reduce((s, p) => s + (Number(p.cuota) || 0), 0)),
      vencen_30: activos.filter(p => p.dias_proximo_pago != null && p.dias_proximo_pago <= 30).length,
      vencidos: activos.filter(p => p.dias_proximo_pago != null && p.dias_proximo_pago < 0).length
    };
    return reply(200, { ok: true, empresa: empresa.nombreCorto, resumen, prestamos });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
