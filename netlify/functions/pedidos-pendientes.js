// netlify/functions/pedidos-pendientes.js
// Pedidos (órdenes de venta) ABIERTAS en SAP = por despachar. Scopeado por rol:
// admin ve todas; vendedor solo las suyas (por SalesPersonCode de cobranza_vendedores).
// POST { email } -> { ok, pedidos:[{docNum,cliente,fecha,vence,total,dias,vendedor}], total, scope }
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { SAP_URL, sapLogin, sapLogout } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

async function sapCodesDeCorreo(sb, email) {
  const target = (email || '').trim().toLowerCase();
  if (!target) return [];
  const { data } = await sb.from('cobranza_vendedores').select('sap_code,email,activo');
  return (data || []).filter(r => r.activo !== false && (r.email || '').toLowerCase().split(/[,;]/).map(s => s.trim()).includes(target))
    .map(r => r.sap_code).filter(c => c != null);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  let b = {}; try { b = JSON.parse(event.body || '{}'); } catch (_) {}

  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
  const email = (b.email || '').trim().toLowerCase();
  const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
  const esAdmin = !!adminEmail && email === adminEmail;

  let filtro = "DocumentStatus eq 'bost_Open'";
  let codes = null;
  if (!esAdmin) {
    codes = await sapCodesDeCorreo(sb, email);
    if (!codes.length) return reply(200, { ok: true, pedidos: [], total: 0, scope: { esAdmin, sinCodigos: true } });
    filtro += ' and (' + codes.map(c => `SalesPersonCode eq ${Number(c)}`).join(' or ') + ')';
  }

  let cookie;
  try {
    cookie = await sapLogin();
    const path = `Orders?$select=DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,SalesPersonCode&$filter=${encodeURIComponent(filtro)}&$orderby=DocDate desc&$top=300`;
    const res = await fetch(`${SAP_URL}/${path}`, { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, agent });
    const j = await res.json();
    await sapLogout(cookie); cookie = null;
    if (!res.ok) return reply(200, { ok: false, error: (j && j.error && j.error.message && j.error.message.value) || ('SAP ' + res.status) });
    const hoy = new Date();
    const pedidos = (j.value || []).map(o => {
      const f = (o.DocDate || '').slice(0, 10);
      const dias = f ? Math.round((hoy - new Date(f + 'T00:00:00')) / 86400000) : null;
      return { docNum: o.DocNum, cliente: o.CardName || o.CardCode, fecha: f, vence: (o.DocDueDate || '').slice(0, 10), total: Number(o.DocTotal) || 0, dias, sp: o.SalesPersonCode };
    });
    const total = pedidos.reduce((s, p) => s + p.total, 0);
    return reply(200, { ok: true, pedidos, total, scope: { esAdmin } });
  } catch (e) {
    if (cookie) try { await sapLogout(cookie); } catch (_) {}
    return reply(500, { ok: false, error: e.message });
  }
};
