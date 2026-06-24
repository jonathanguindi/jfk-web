// cobranzas-estado.js · Estado de los correos recurrentes de cobranza (cobranza_envios) — SOLO ADMIN.
// Lee con SERVICE KEY (así funciona aunque la tabla no sea legible por anon) y devuelve métricas
// para el vigía G7: enviados hoy/7d por cadencia, errores, pendientes atascados, último envío.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

async function count(sb, build) {
  const { count: n, error } = await build(sb.from('cobranza_envios').select('id', { count: 'exact', head: true }));
  if (error) throw new Error(error.message);
  return n || 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const now = new Date();
    const hoy0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const ayer0 = new Date(Date.now() - 24 * 3600e3).toISOString();
    const hace7 = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();

    // Si la tabla no existe, lo reportamos limpio.
    try { await count(sb, q => q); } catch (e) {
      if (/relation|does not exist/i.test(e.message)) return reply(200, { ok: true, modulo_activo: false, empresa: empresa.nombreCorto });
      throw e;
    }

    const total = await count(sb, q => q);
    const enviadosHoy = await count(sb, q => q.eq('status', 'enviado').gte('sent_at', hoy0));
    const enviados7 = await count(sb, q => q.eq('status', 'enviado').gte('sent_at', hace7));
    const env7diario = await count(sb, q => q.eq('status', 'enviado').gte('sent_at', hace7).eq('cadencia', 'diario'));
    const env7semanal = await count(sb, q => q.eq('status', 'enviado').gte('sent_at', hace7).eq('cadencia', 'semanal'));
    const errores7 = await count(sb, q => q.eq('status', 'error').gte('created_at', hace7));
    const pendViejos = await count(sb, q => q.eq('status', 'pendiente').lt('created_at', ayer0));
    const pendTotal = await count(sb, q => q.eq('status', 'pendiente'));

    const { data: ult } = await sb.from('cobranza_envios').select('customer_name,sent_at,cadencia').eq('status', 'enviado').order('sent_at', { ascending: false }).limit(1);
    const { data: errs } = await sb.from('cobranza_envios').select('customer_name,error,created_at').eq('status', 'error').order('created_at', { ascending: false }).limit(5);

    return reply(200, {
      ok: true, modulo_activo: true, empresa: empresa.nombreCorto,
      total, enviados_hoy: enviadosHoy, enviados_7d: enviados7,
      enviados_7d_diario: env7diario, enviados_7d_semanal: env7semanal,
      errores_7d: errores7, pendientes_total: pendTotal, pendientes_viejos: pendViejos,
      ultimo_envio: (ult && ult[0]) || null,
      errores_muestra: errs || []
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
