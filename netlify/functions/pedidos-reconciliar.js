// pedidos-reconciliar.js · Rellena el # de SAP en pedidos del portal que se quedaron sin él.
// Causa: a veces SAP crea la orden pero el portal pierde la respuesta (timeout / cierran la pantalla),
// y el pedido queda en Supabase con status 'submitted'/'sap_error' y sap_doc_num NULL.
// Esto busca en SAP por NumAtCard (la referencia PED-...) y rellena doc_num/doc_entry/status.
// SOLO LECTURA de SAP. Gate: token (VENTAS_SYNC_TOKEN), admin, o disparo programado.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { SAP_URL, sapLogin } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

async function sapGet(cookie, path) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(`${SAP_URL}/${path}`, { headers: { Cookie: cookie, 'Content-Type': 'application/json', Prefer: 'odata.maxpagesize=100' }, signal: ac.signal });
    const j = await r.json().catch(() => null);
    return (j && j.value) || [];
  } catch (e) { return []; } finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    const token = body.token || (event.queryStringParameters && event.queryStringParameters.token) || '';
    const esProgramado = !!body.next_run;
    const esAdmin = (body.email || '').trim().toLowerCase() === adminEmail;
    if (!esProgramado && !esAdmin && process.env.VENTAS_SYNC_TOKEN && token !== process.env.VENTAS_SYNC_TOKEN) {
      return reply(403, { ok: false, error: 'No autorizado' });
    }

    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado (falta service key)' });

    // 1) Pedidos del portal sin # de SAP (los más recientes primero). Solo los que tienen referencia PED-...
    const limite = Math.min(Math.max(Number(body.limite) || 400, 1), 1000);
    const { data: pend, error: e1 } = await sb
      .from('orders')
      .select('id, order_number, status')
      .is('sap_doc_num', null)
      .not('order_number', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limite);
    if (e1) return reply(200, { ok: false, error: 'leyendo orders: ' + e1.message });
    const pendientes = (pend || []).filter(o => /^PED-/.test(o.order_number || ''));
    if (!pendientes.length) return reply(200, { ok: true, pendientes: 0, encontrados: 0, actualizados: 0, mensaje: 'Nada por reconciliar' });

    // 2) Buscar en SAP por NumAtCard, en lotes (OR), construir mapa ref -> {DocNum, DocEntry, Cancelled}.
    const cookie = await sapLogin();
    const mapa = new Map();
    for (const lote of chunk(pendientes, 18)) {
      const filtro = lote.map(o => `NumAtCard eq '${String(o.order_number).replace(/'/g, "''")}'`).join(' or ');
      const rows = await sapGet(cookie, `Orders?$filter=${encodeURIComponent(filtro)}&$select=DocNum,DocEntry,NumAtCard,Cancelled,DocumentStatus`);
      rows.forEach(r => { if (r.NumAtCard) mapa.set(r.NumAtCard, r); });
    }

    // 3) Actualizar en Supabase los que sí están en SAP.
    let actualizados = 0; const errores = [];
    for (const o of pendientes) {
      const s = mapa.get(o.order_number);
      if (!s) continue;
      const cancelado = s.Cancelled === 'tYES';
      const upd = {
        sap_doc_num: s.DocNum,
        sap_doc_entry: s.DocEntry,
        status: cancelado ? 'cancelled' : 'sap_created',
        sap_synced_at: new Date().toISOString()
      };
      const { error } = await sb.from('orders').update(upd).eq('id', o.id);
      if (error) errores.push(o.order_number + ': ' + error.message);
      else actualizados++;
    }

    return reply(200, {
      ok: true, empresa: empresa.nombreCorto,
      pendientes: pendientes.length,
      encontrados_en_sap: mapa.size,
      actualizados,
      no_encontrados: pendientes.length - mapa.size,
      errores: errores.slice(0, 10)
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
