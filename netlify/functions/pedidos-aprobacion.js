// pedidos-aprobacion.js · Aprobación de pedidos (Orders) desde el portal.
// acciones: listar (no autorizados) | detalle (margen por producto) | buscar | autorizar | cancelar.
// "No autorizado" = NTSApproved='tNO'. Autorizar => NTSApproved='tYES' (lo que permite trabajarlo en bodega).
// Margen por línea: UnitPrice (venta), GrossBuyPrice (costo), GrossProfit (ganancia) — vienen de SAP.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { SAP_URL, sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function sap(cookie, path, method, bodyObj) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 13000);
  try {
    const r = await fetch(`${SAP_URL}/${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: bodyObj ? JSON.stringify(bodyObj) : undefined, signal: ac.signal });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
    return { ok: r.ok || r.status === 204, status: r.status, json: j, text: txt };
  } finally { clearTimeout(t); }
}
const sapErr = (res) => String((res.json && res.json.error && (res.json.error.message?.value || res.json.error.message)) || res.text || ('HTTP ' + res.status)).slice(0, 250);

function margenDeOrden(o) {
  const lineas = (o.DocumentLines || []).map(l => {
    const qty = Number(l.Quantity) || 0;
    const venta = (Number(l.UnitPrice) || 0) * qty;
    const ganancia = (l.GrossProfit != null) ? Number(l.GrossProfit) : (venta - (Number(l.GrossBuyPrice) || 0) * qty);
    const costo = venta - ganancia;
    return {
      item: l.ItemCode, desc: l.ItemDescription, qty,
      precio_venta: r2(l.UnitPrice), costo_unit: r2(l.GrossBuyPrice),
      venta: r2(venta), costo: r2(costo), ganancia: r2(ganancia),
      margen_pct: venta > 0 ? Math.round(ganancia / venta * 1000) / 10 : 0
    };
  });
  const venta = lineas.reduce((s, l) => s + l.venta, 0);
  const ganancia = lineas.reduce((s, l) => s + l.ganancia, 0);
  return {
    lineas, venta_total: r2(venta), costo_total: r2(venta - ganancia), ganancia_total: r2(ganancia),
    margen_final: venta > 0 ? Math.round(ganancia / venta * 1000) / 10 : 0
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    const email = (body.email || '').trim().toLowerCase();
    // Validar vendedor; autorizar/cancelar requieren admin.
    let seller = null;
    if (sb) { const { data } = await sb.from('sellers').select('role,active').eq('email', email).maybeSingle(); seller = data; }
    if (!seller || seller.active === false) return reply(403, { ok: false, error: 'No autorizado' });
    const accion = body.accion || 'listar';
    const esAdmin = seller.role === 'admin';

    const cookie = await sapLogin();

    if (accion === 'listar') {
      const rows = await sapGetAll(cookie, "Orders?$filter=DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and NTSApproved eq 'tNO'&$orderby=DocEntry desc&$select=DocEntry,DocNum,CardCode,CardName,DocTotal,DocDate,Comments");
      return reply(200, { ok: true, pedidos: (rows || []).map(o => ({ doc_entry: o.DocEntry, doc_num: o.DocNum, card_code: o.CardCode, cliente: o.CardName, total: r2(o.DocTotal), fecha: (o.DocDate || '').slice(0, 10) })) });
    }

    if (accion === 'detalle' || accion === 'buscar') {
      let path;
      if (body.doc_entry) path = `Orders(${Number(body.doc_entry)})`;
      else if (body.doc_num) {
        const f = await sapGetAll(cookie, `Orders?$filter=DocNum eq ${Number(body.doc_num)}&$select=DocEntry`);
        if (!f || !f.length) return reply(200, { ok: false, error: 'No se encontró el pedido ' + body.doc_num });
        path = `Orders(${f[0].DocEntry})`;
      } else return reply(200, { ok: false, error: 'Falta doc_entry o doc_num' });
      const res = await sap(cookie, path, 'GET');
      if (!res.ok || !res.json) return reply(200, { ok: false, error: sapErr(res) });
      const o = res.json;
      return reply(200, {
        ok: true,
        pedido: {
          doc_entry: o.DocEntry, doc_num: o.DocNum, cliente: o.CardName, card_code: o.CardCode,
          fecha: (o.DocDate || '').slice(0, 10), total: r2(o.DocTotal),
          estado: o.DocumentStatus, autorizado: o.NTSApproved === 'tYES', cancelado: o.Cancelled === 'tYES',
          comentarios: o.Comments || '', ...margenDeOrden(o)
        }
      });
    }

    if (accion === 'autorizar') {
      if (!esAdmin) return reply(403, { ok: false, error: 'Solo el administrador puede autorizar' });
      const de = Number(body.doc_entry); if (!Number.isFinite(de)) return reply(200, { ok: false, error: 'doc_entry requerido' });
      const res = await sap(cookie, `Orders(${de})`, 'PATCH', { NTSApproved: 'tYES' });
      if (!res.ok) return reply(200, { ok: false, error: sapErr(res) });
      return reply(200, { ok: true, autorizado: true });
    }

    if (accion === 'cancelar') {
      if (!esAdmin) return reply(403, { ok: false, error: 'Solo el administrador puede cancelar' });
      const de = Number(body.doc_entry); if (!Number.isFinite(de)) return reply(200, { ok: false, error: 'doc_entry requerido' });
      const res = await sap(cookie, `Orders(${de})/Cancel`, 'POST');
      if (!res.ok) return reply(200, { ok: false, error: sapErr(res) });
      return reply(200, { ok: true, cancelado: true });
    }

    return reply(200, { ok: false, error: 'acción no válida' });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
