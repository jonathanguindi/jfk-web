// cobranzas-lista.js · Lista detallada de envíos de cobranza (cobranza_envios) para el cuadro. SOLO ADMIN.
// Devuelve a quién se le mandó: cliente, correo, saldo/vencido, cadencia, estado, fecha.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

    const filtro = body.filtro || 'hoy';   // hoy | 7d | mes | todos
    const now = new Date();
    let desde = null;
    if (filtro === 'hoy') desde = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    else if (filtro === '7d') desde = new Date(Date.now() - 7 * 864e5).toISOString();
    else if (filtro === 'mes') desde = new Date(Date.now() - 30 * 864e5).toISOString();

    // Traer enviados (y opcionalmente errores) en el rango, por fecha de envío o creación.
    let q = sb.from('cobranza_envios')
      .select('customer_name,email,sap_card_code,saldo,vencido,atraso_dias,cadencia,tipo,status,sent_at,created_at,error')
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(500);
    if (desde) q = q.or(`sent_at.gte.${desde},created_at.gte.${desde}`);
    const { data, error } = await q;
    if (error) return reply(200, { ok: false, error: error.message });

    const rows = (data || []).map(r => ({
      cliente: r.customer_name || r.sap_card_code, codigo: r.sap_card_code, correo: r.email || '',
      vencido: r2(r.vencido), saldo: r2(r.saldo), atraso: r.atraso_dias, cadencia: r.cadencia || '—',
      tipo: r.tipo, status: r.status, fecha: (r.sent_at || r.created_at || '').slice(0, 16).replace('T', ' '),
      error: r.error || ''
    }));
    const enviados = rows.filter(r => r.status === 'enviado');
    return reply(200, {
      ok: true, empresa: empresa.nombreCorto, filtro,
      resumen: {
        enviados: enviados.length,
        monto_vencido: r2(enviados.reduce((s, r) => s + (Number(r.vencido) || 0), 0)),
        errores: rows.filter(r => r.status === 'error').length,
        pendientes: rows.filter(r => r.status === 'pendiente').length
      },
      envios: rows
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
