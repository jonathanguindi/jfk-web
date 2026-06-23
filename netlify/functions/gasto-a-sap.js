// gasto-a-sap.js · Postea un gasto a SAP como Factura de Servicio (A/P) al proveedor. SOLO ADMIN, ESCRITURA.
// acciones: postear (crea PurchaseInvoices dDocument_Service) | cancelar (anula por DocEntry).
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { SAP_URL, sapLogin } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const ITBMS_ACCT = process.env.SAP_ITBMS_ACCT || '610224';

async function sapJSON(cookie, path, method, bodyObj) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 13000);
  try {
    const r = await fetch(`${SAP_URL}/${path}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined, signal: ac.signal
    });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json: j, text: txt };
  } finally { clearTimeout(t); }
}
const sapErr = (res) => String((res.json && res.json.error && (res.json.error.message?.value || res.json.error.message)) || res.text || ('HTTP ' + res.status)).slice(0, 300);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const email = (body.email || '').trim().toLowerCase();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if (email !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();
    const accion = body.accion || 'postear';

    if (accion === 'cancelar') {
      const de = Number(body.doc_entry);
      if (!Number.isFinite(de)) return reply(200, { ok: false, error: 'doc_entry requerido' });
      const res = await sapJSON(cookie, `PurchaseInvoices(${de})/Cancel`, 'POST');
      if (!res.ok) return reply(200, { ok: false, error: sapErr(res) });
      if (body.id) await sb.from('gastos').update({ estado: 'registrado', sap_doc_entry: null }).eq('id', Number(body.id));
      return reply(200, { ok: true });
    }

    // postear
    const { data: g, error } = await sb.from('gastos').select('*').eq('id', Number(body.id)).maybeSingle();
    if (error || !g) return reply(200, { ok: false, error: 'Gasto no encontrado' });
    if (g.sap_doc_entry) return reply(200, { ok: false, error: 'Este gasto ya fue posteado a SAP (factura ' + g.sap_doc_entry + ')' });
    if (!g.proveedor_codigo) return reply(200, { ok: false, error: 'Falta elegir el proveedor (SAP) en el gasto.' });
    if (!g.cuenta_gasto) return reply(200, { ok: false, error: 'Falta elegir la cuenta de gasto (SAP).' });

    const monto = Number(g.monto) || 0;
    const itbms = Number(body.itbms || 0) || 0;            // opcional, separado
    const neto = Math.round((monto - itbms) * 100) / 100;
    const fecha = (g.fecha || new Date().toISOString().slice(0, 10));
    const lineas = [{ AccountCode: g.cuenta_gasto, LineTotal: neto, ItemDescription: (g.descripcion || g.categoria || 'Gasto').slice(0, 100) }];
    if (itbms > 0) lineas.push({ AccountCode: ITBMS_ACCT, LineTotal: itbms, ItemDescription: 'ITBMS' });

    const factura = {
      CardCode: g.proveedor_codigo,
      DocDate: fecha, DocDueDate: fecha, TaxDate: fecha,
      DocType: 'dDocument_Service',
      Comments: ('Gasto registrado desde el portal Contabilidad. ' + (g.descripcion || '')).slice(0, 250),
      DocumentLines: lineas
    };
    const res = await sapJSON(cookie, 'PurchaseInvoices', 'POST', factura);
    if (!res.ok) return reply(200, { ok: false, error: sapErr(res) });
    const inv = res.json || {};
    await sb.from('gastos').update({ sap_doc_entry: inv.DocEntry, estado: 'en_sap' }).eq('id', g.id);
    return reply(200, { ok: true, doc_entry: inv.DocEntry, doc_num: inv.DocNum, total: inv.DocTotal });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
