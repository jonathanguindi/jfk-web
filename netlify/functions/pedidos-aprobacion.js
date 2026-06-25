// pedidos-aprobacion.js · Aprobación de pedidos (Orders) desde el portal.
// acciones: listar (no autorizados) | detalle (margen por producto) | buscar | autorizar | cancelar.
// "No autorizado" = Confirmed='tNO' (checkbox "Autorizado" de Logística). Autorizar => Confirmed='tYES' (permite trabajarlo en bodega).
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

async function vendMap(cookie) {
  const v = await sapGetAll(cookie, 'SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName').catch(() => []);
  const m = new Map(); (v || []).forEach(x => m.set(x.SalesEmployeeCode, x.SalesEmployeeName)); return m;
}
const nombreVend = (m, code) => (code != null && code > 0) ? (m.get(code) || '') : '';

// --- Cachés a nivel de instancia (sobreviven entre invocaciones "tibias" del mismo Lambda) ---
// SAP es lento: cada login y cada lectura de vendedores es un viaje de ~3-4s. Reusarlos hace que
// abrir un pedido pase de ~9s a ~3s. La sesión de SAP dura ~30 min; usamos TTL menores y reintento.
let _cookie = null, _cookieAt = 0;
let _vm = null, _vmAt = 0;
const COOKIE_TTL = 20 * 60 * 1000, VM_TTL = 30 * 60 * 1000;
async function freshCookie() { _cookie = await sapLogin(); _cookieAt = Date.now(); return _cookie; }
async function getCookie() { return (_cookie && (Date.now() - _cookieAt) < COOKIE_TTL) ? _cookie : freshCookie(); }
async function getVendMap(cookie) {
  if (_vm && (Date.now() - _vmAt) < VM_TTL) return _vm;
  _vm = await vendMap(cookie); _vmAt = Date.now(); return _vm;
}
const esAuthFail = (res) => res && (res.status === 401 || res.status === 403 && /session|login|invalid/i.test(res.text || ''));

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

    let cookie = await getCookie();
    // Reintenta un GET/PATCH/POST una vez si la sesión cacheada expiró.
    const sapR = async (path, method, b) => {
      let res = await sap(cookie, path, method, b);
      if (esAuthFail(res)) { cookie = await freshCookie(); _vm = null; res = await sap(cookie, path, method, b); }
      return res;
    };

    if (accion === 'listar') {
      const [rows, vm] = await Promise.all([
        sapGetAll(cookie, "Orders?$filter=DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and Confirmed eq 'tNO'&$orderby=DocEntry desc&$select=DocEntry,DocNum,CardCode,CardName,DocTotal,DocDate,Comments,SalesPersonCode"),
        getVendMap(cookie)
      ]);
      return reply(200, { ok: true, pedidos: (rows || []).map(o => ({ doc_entry: o.DocEntry, doc_num: o.DocNum, card_code: o.CardCode, cliente: o.CardName, total: r2(o.DocTotal), fecha: (o.DocDate || '').slice(0, 10), vendedor: nombreVend(vm, o.SalesPersonCode) })) });
    }

    if (accion === 'detalle' || accion === 'buscar') {
      let path;
      if (body.doc_entry) path = `Orders(${Number(body.doc_entry)})`;
      else if (body.doc_num) {
        const f = await sapGetAll(cookie, `Orders?$filter=DocNum eq ${Number(body.doc_num)}&$select=DocEntry`);
        if (!f || !f.length) return reply(200, { ok: false, error: 'No se encontró el pedido ' + body.doc_num });
        path = `Orders(${f[0].DocEntry})`;
      } else return reply(200, { ok: false, error: 'Falta doc_entry o doc_num' });
      const [res, vm] = await Promise.all([sapR(path, 'GET'), getVendMap(cookie)]);
      if (!res.ok || !res.json) return reply(200, { ok: false, error: sapErr(res) });
      const o = res.json;
      return reply(200, {
        ok: true,
        pedido: {
          doc_entry: o.DocEntry, doc_num: o.DocNum, cliente: o.CardName, card_code: o.CardCode,
          vendedor: nombreVend(vm, o.SalesPersonCode),
          fecha: (o.DocDate || '').slice(0, 10), total: r2(o.DocTotal),
          estado: o.DocumentStatus, autorizado: o.Confirmed === 'tYES', cancelado: o.Cancelled === 'tYES',
          comentarios: o.Comments || '', ...margenDeOrden(o)
        }
      });
    }

    if (accion === 'autorizar') {
      if (!esAdmin) return reply(403, { ok: false, error: 'Solo el administrador puede autorizar' });
      const de = Number(body.doc_entry); if (!Number.isFinite(de)) return reply(200, { ok: false, error: 'doc_entry requerido' });
      const res = await sapR(`Orders(${de})`, 'PATCH', { Confirmed: 'tYES' });
      if (!res.ok) return reply(200, { ok: false, error: sapErr(res) });
      return reply(200, { ok: true, autorizado: true });
    }

    if (accion === 'cancelar') {
      if (!esAdmin) return reply(403, { ok: false, error: 'Solo el administrador puede cancelar' });
      const de = Number(body.doc_entry); if (!Number.isFinite(de)) return reply(200, { ok: false, error: 'doc_entry requerido' });
      const res = await sapR(`Orders(${de})/Cancel`, 'POST');
      if (!res.ok) return reply(200, { ok: false, error: sapErr(res) });
      return reply(200, { ok: true, cancelado: true });
    }

    return reply(200, { ok: false, error: 'acción no válida' });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
