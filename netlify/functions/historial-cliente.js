// historial-cliente.js · historial de compras del cliente desde SAP
// Robusto para clientes grandes (ej. Freund):
//  - Consulta válida (factura completa con sus líneas embebidas, como el original).
//  - Filtro de fecha: por defecto desde 2020 (configurable por body 'desde' o env HISTORIAL_DESDE).
//  - Trae de la factura MÁS RECIENTE a la más vieja y es RESILIENTE: si SAP se tarda,
//    devuelve lo que alcanzó a traer (no falla con 0). Así siempre hay productos recientes.
const SAP_URL = process.env.SAP_SERVICE_LAYER_URL || '';
const SAP_DB  = process.env.SAP_COMPANY_DB || '';
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME || '';
const SAP_PASSWORD = process.env.SAP_PASSWORD || '';

const MAX_PAGES = 5;            // tope de páginas de facturas
const PAGE_SIZE = 20;           // facturas por página
const CALL_TIMEOUT_MS = 7000;   // corta una llamada SAP que se cuelgue
const TOTAL_BUDGET_MS = 8500;   // no iniciar otra página pasado esto (margen al límite de Netlify)

function defaultDesde() {
  return process.env.HISTORIAL_DESDE || '2020-01-01';
}

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'content-type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type':'application/json', ...cors }, body: JSON.stringify(obj) });

async function sapFetch(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
async function sapLogin(){
  const r = await sapFetch(`${SAP_URL}/Login`, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASSWORD }) });
  if(!r.ok) throw new Error(`SAP login ${r.status}: ${await r.text()}`);
  const sc = r.headers.get('set-cookie') || '';
  return sc.split(',').map(c=>c.split(';')[0].trim()).filter(Boolean).join('; ');
}
const sapLogout = async (c)=>{ try{ await sapFetch(`${SAP_URL}/Logout`,{method:'POST',headers:{Cookie:c}}); }catch(_){} };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok:true });
  if (event.httpMethod !== 'POST')   return reply(405, { ok:false, error:'Method not allowed' });
  let cookie;
  try {
    const { cardCode, desde } = JSON.parse(event.body || '{}');
    if (!cardCode) return reply(200, { ok:false, error:'cardCode requerido' });
    const cc = String(cardCode).replace(/'/g, "''");
    const fechaDesde = (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) ? desde : defaultDesde();
    cookie = await sapLogin();

    // Factura completa (las líneas vienen embebidas en DocumentLines). Filtrada por fecha,
    // ordenada de la más reciente a la más vieja.
    const headers = { Cookie: cookie, Prefer: `odata.maxpagesize=${PAGE_SIZE}` };
    let url = `${SAP_URL}/Invoices?$filter=CardCode eq '${cc}' and DocDate ge '${fechaDesde}'&$orderby=DocDate desc`;

    const invoices = [];
    let parcial = false;
    const t0 = Date.now();
    for (let page = 0; page < MAX_PAGES && url; page++) {
      if (Date.now() - t0 > TOTAL_BUDGET_MS) { parcial = true; break; }
      let r;
      try {
        r = await sapFetch(url, { headers });
      } catch (e) {
        if (e && e.name === 'AbortError') { parcial = true; break; } // timeout: usar lo que tengamos
        throw e;
      }
      if (!r.ok) throw new Error(`SAP Invoices ${r.status}: ${await r.text()}`);
      const j = await r.json();
      (j.value || []).forEach(inv => invoices.push(inv));
      const next = j['@odata.nextLink'];
      url = next ? (next.startsWith('http') ? next : `${SAP_URL}/${next}`) : null;
    }
    await sapLogout(cookie); cookie = null;

    // Agregar por ItemCode (factura más reciente primero)
    const agg = {};
    for (const inv of invoices) {
      const fecha = (inv.DocDate || '').slice(0, 10);
      const vistos = new Set();
      for (const l of (inv.DocumentLines || [])) {
        const code = l.ItemCode; if (!code) continue;
        if (!agg[code]) agg[code] = { item_code: code, item_description: l.ItemDescription || '', qty_total:0, qty_ultima:0, precio_ultimo:0, fecha_ultima:'', veces:0, _seen:false };
        const a = agg[code];
        a.qty_total += Number(l.Quantity) || 0;
        if (!vistos.has(code)) { a.veces += 1; vistos.add(code); }
        if (!a._seen) {
          a.qty_ultima = Number(l.Quantity) || 0;
          a.precio_ultimo = Number(l.Price != null ? l.Price : (l.UnitPrice || 0)) || 0;
          a.fecha_ultima = fecha;
          a._seen = true;
        }
      }
    }
    const productos = Object.values(agg).map(a => ({
      item_code: a.item_code, item_description: a.item_description,
      qty_total: a.qty_total, qty_ultima: a.qty_ultima,
      qty_promedio: a.veces ? Math.round((a.qty_total / a.veces) * 100) / 100 : 0,
      veces_comprado: a.veces, fecha_ultima: a.fecha_ultima, precio_ultimo: a.precio_ultimo,
    }));
    return reply(200, { ok:true, productos, _debug: { facturas: invoices.length, items: productos.length, desde: fechaDesde, parcial } });
  } catch (e) {
    if (cookie) await sapLogout(cookie);
    const msg = (e && e.name === 'AbortError') ? 'SAP tardó demasiado (timeout en una llamada)' : (e.message || String(e));
    return reply(200, { ok:false, error: msg });
  }
};
