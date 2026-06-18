// ventas-sync-cursor.js · Mueve el cursor de sincronización a una fecha reciente,
// para que el backfill baje PRIMERO los últimos años (no desde 2007).
// POST { token, desde }  (desde por defecto '2020-01-01').
// Pone last_doc_entry = (primer DocEntry con DocDate>=desde) - 1, para Facturas y Notas de Crédito.
const { sapLogin, sapLogout, primerDocEntryDesde } = require('./lib/sap-ventas');
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  const expected = process.env.VENTAS_SYNC_TOKEN || process.env.COBRANZA_RUN_TOKEN;
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  if (!expected || body.token !== expected) return reply(401, { ok: false, error: 'Token inválido o no configurado' });

  const desde = /^\d{4}-\d{2}-\d{2}$/.test(body.desde || '') ? body.desde : '2020-01-01';
  let cookie;
  try {
    const sb = getSupabase(getEmpresa());
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    cookie = await sapLogin();
    const out = {};
    for (const [docType, recurso] of [['I', 'Invoices'], ['C', 'CreditNotes']]) {
      const de = await primerDocEntryDesde(cookie, recurso, desde);
      const cursor = de != null ? de - 1 : 0;
      await sb.from('ventas_sync_state').update({ last_doc_entry: cursor, full_done: false, updated_at: new Date().toISOString() }).eq('doc_type', docType);
      out[recurso] = { primer_docentry: de, cursor };
    }
    await sapLogout(cookie); cookie = null;
    return reply(200, { ok: true, desde, cursores: out });
  } catch (e) {
    if (cookie) await sapLogout(cookie);
    return reply(500, { ok: false, error: e.message });
  }
};
