// ventas-dashboard.js · Devuelve los datos agregados del dashboard de ventas.
// POST { desde, hasta }                  -> resumen completo (RPC ventas_resumen)
// POST { cardCode, desde, hasta }        -> detalle de un cliente (RPC ventas_cliente_detalle)
// Lee de Supabase con la service key (los hechos no se exponen al navegador).
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

function rango(body) {
  const hoy = new Date();
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(body.hasta || '') ? body.hasta : hoy.toISOString().slice(0, 10);
  const desdeDef = new Date(hoy.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(body.desde || '') ? body.desde : desdeDef;
  return { desde, hasta };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });

  try {
    const body = JSON.parse(event.body || '{}');
    const sb = getSupabase(getEmpresa());
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const { desde, hasta } = rango(body);

    if (body.cardCode) {
      const { data, error } = await sb.rpc('ventas_cliente_detalle', { p_card: body.cardCode, desde, hasta });
      if (error) return reply(500, { ok: false, error: error.message });
      return reply(200, { ok: true, detalle: data });
    }

    const p_vendedor = (body.vendedor != null && body.vendedor !== '') ? Number(body.vendedor) : null;
    const p_pais = body.pais ? String(body.pais) : null;
    const [{ data: resumen, error }, { data: estado }] = await Promise.all([
      sb.rpc('ventas_resumen', { desde, hasta, p_vendedor, p_pais }),
      sb.from('ventas_sync_state').select('doc_type,last_doc_entry,full_done,rows_total,updated_at'),
    ]);
    if (error) return reply(500, { ok: false, error: error.message });
    return reply(200, { ok: true, resumen, sync: estado || [] });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
