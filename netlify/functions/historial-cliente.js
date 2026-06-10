// historial-cliente.js · historial de compras del cliente desde SAP
//  - Filtro de fecha: desde 2020 por defecto (configurable por body 'desde' o env HISTORIAL_DESDE).
//  - Trae las facturas MÁS livianas posibles ($select=DocDate,DocumentLines) para que quepan
//    muchas más en el tiempo límite y se pueda retroceder hasta 2020. Si tu SAP no acepta ese
//    recorte, hace fallback automático a la factura completa.
//  - RESILIENTE: si SAP se tarda, devuelve lo que alcanzó (no falla con 0).
const SAP_URL = process.env.SAP_SERVICE_LAYER_URL || '';
const SAP_DB  = process.env.SAP_COMPANY_DB || '';
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME || '';
const SAP_PASSWORD = process.env.SAP_PASSWORD || '';

const MAX_PAGES = 12;           // tope de páginas
const PAGE_SIZE = 50;           // facturas por página (livianas)
const CALL_TIMEOUT_MS = 7000;   // corta una llamada SAP colgada
const TOTAL_BUDGET_MS = 9000;   // no iniciar otra página pasado esto (margen al límite de Netlify)

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

    const headers = { Cookie: cookie, Prefer: `odata.maxpagesize=${PAGE_SIZE}` };
    const filtro = `$filter=CardCode eq '${cc}' and DocDate ge '${fechaDesde}'&$orderby=DocDate desc`;
    const urlSelect = `${SAP_URL}/Invoices?$select=DocDate,DocumentLines&${filtro}`; // liviana
    const urlFull   = `${SAP_URL}/Invoices?${filtro}`;                               // completa (fallback)

    const invoices = [];
    let parcial = false, modo = 'select';
    let url = urlSelect;
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
      if (!r.ok) {
        const txt = await r.text();
        // Si el $select con DocumentLines no es válido en este SAP, reintentar con factura completa
        if (modo === 'select' && /DocumentLines|\$?select/i.test(txt)) {
          modo = 'full'; url = urlFull; page = -1; invoices.length = 0; continue;
        }
        throw new Error(`SAP Invoices ${r.status}: ${txt}`);
      }
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
    return reply(200, { ok:true, productos, _debug: { facturas: invoices.length, items: productos.length, desde: fechaDesde, parcial, modo } });
  } catch (e) {
    if (cookie) await sapLogout(cookie);
    const msg = (e && e.name === 'AbortError') ? 'SAP tardó demasiado (timeout en una llamada)' : (e.message || String(e));
    return reply(200, { ok:false, error: msg });
  }
};
