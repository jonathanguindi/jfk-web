// ventas-dashboard.js · Datos agregados del dashboard de ventas, con acceso por rol.
//  POST { email, desde, hasta, vendedor?, pais? }   -> resumen (RPC ventas_resumen)
//  POST { email, cardCode, desde, hasta }            -> detalle de cliente
// ACCESO: solo el correo administrador (empresa.admin) ve TODO. Cualquier otro correo
// queda forzado a SUS propios códigos de vendedor (cobranza_vendedores) — no puede ver
// ventas de otros aunque manipule el front. Lee de Supabase con la service key.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

function rango(body) {
  const hoy = new Date();
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(body.hasta || '') ? body.hasta : hoy.toISOString().slice(0, 10);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(body.desde || '') ? body.desde
    : new Date(hoy.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  return { desde, hasta };
}

// Códigos de vendedor (SAP) asociados a un correo, según cobranza_vendedores.
async function sapCodesDeCorreo(sb, email) {
  const target = (email || '').trim().toLowerCase();
  if (!target) return [];
  const { data: rows } = await sb.from('cobranza_vendedores').select('sap_code,email,activo');
  return (rows || [])
    .filter(r => r.activo !== false && (r.email || '').toLowerCase().split(/[,;]/).map(s => s.trim()).includes(target))
    .map(r => r.sap_code).filter(c => c != null);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });

  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });

    const email = (body.email || '').trim().toLowerCase();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    const esAdmin = !!adminEmail && email === adminEmail;

    // Alcance de vendedor: admin = libre (o el filtro que elija); vendedor = SUS códigos.
    let p_vendedores = null;       // null = todos (solo admin)
    let scope = { esAdmin, vendedor: null };
    if (!esAdmin) {
      const codes = await sapCodesDeCorreo(sb, email);
      // Si no encontramos códigos, devolvemos un set imposible para no filtrar datos de otros.
      p_vendedores = codes.length ? codes : [-1];
      scope.vendedor = codes;
    } else if (body.vendedor != null && body.vendedor !== '') {
      p_vendedores = [Number(body.vendedor)];   // admin filtrando por un vendedor
    }

    const { desde, hasta } = rango(body);

    if (body.comparativo) {
      const p_pais = body.pais ? String(body.pais) : null;
      const { data, error } = await sb.rpc('ventas_comparativo', { desde, hasta, p_vendedores, p_pais });
      if (error) return reply(500, { ok: false, error: error.message });
      return reply(200, { ok: true, comparativo: data, scope });
    }

    if (body.cardCode && body.reco) {
      const { data, error } = await sb.rpc('ventas_recomendaciones', { p_card: body.cardCode, p_vendedores });
      if (error) return reply(500, { ok: false, error: error.message });
      return reply(200, { ok: true, reco: data, scope });
    }

    if (body.cardCode) {
      const { data, error } = await sb.rpc('ventas_cliente_detalle', { p_card: body.cardCode, desde, hasta, p_vendedores });
      if (error) return reply(500, { ok: false, error: error.message });
      return reply(200, { ok: true, detalle: data, scope });
    }

    const p_pais = body.pais ? String(body.pais) : null;
    const [{ data: resumen, error }, estadoRes] = await Promise.all([
      sb.rpc('ventas_resumen', { desde, hasta, p_vendedores, p_pais }),
      esAdmin ? sb.from('ventas_sync_state').select('doc_type,last_doc_entry,full_done,rows_total,updated_at') : Promise.resolve({ data: [] }),
    ]);
    if (error) return reply(500, { ok: false, error: error.message });
    return reply(200, { ok: true, resumen, sync: estadoRes.data || [], scope });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
