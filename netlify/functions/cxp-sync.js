// cxp-sync.js · Vuelca a Supabase (tabla cxp_revision) las facturas de compra ABIERTAS de SAP,
// para revisarlas y marcarlas (activa/cerrar). SOLO LECTURA de SAP, SOLO ADMIN.
// Conserva la decisión/nota ya puesta (no la sobrescribe) y borra las que ya se cerraron en SAP.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dias = (a, b) => Math.round((a - b) / 86400000);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();
    const path = "PurchaseInvoices?$select=DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,PaidToDate,DocCurrency&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocDueDate asc";
    const rows = await sapGetAll(cookie, path);

    const hoy = new Date();
    const meses = 18;
    const corte = new Date(hoy.getFullYear(), hoy.getMonth() - meses, hoy.getDate());

    const filas = [];
    for (const f of rows) {
      const saldo = (Number(f.DocTotal) || 0) - (Number(f.PaidToDate) || 0);
      if (saldo <= 0.01) continue;
      const fecha = f.DocDate ? new Date(f.DocDate.slice(0, 10) + 'T00:00:00') : null;
      const due = f.DocDueDate ? new Date(f.DocDueDate.slice(0, 10) + 'T00:00:00') : null;
      filas.push({
        doc_entry: f.DocEntry,
        doc_num: f.DocNum != null ? f.DocNum : null,
        card_code: f.CardCode || null,
        proveedor: f.CardName || f.CardCode || null,
        fecha: f.DocDate ? f.DocDate.slice(0, 10) : null,
        vence: f.DocDueDate ? f.DocDueDate.slice(0, 10) : null,
        saldo: r2(saldo),
        atraso: due ? dias(hoy, due) : 0,
        anio: fecha ? fecha.getFullYear() : null,
        vigente: saldo >= 1 && (!fecha || fecha >= corte),
        moneda: f.DocCurrency || null,
        synced_at: hoy.toISOString()
        // OJO: NO incluimos decision/nota → upsert no las toca (conserva lo marcado).
      });
    }

    // Upsert por lotes (conserva decision/nota porque no están en el payload).
    let escritas = 0;
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500);
      const { error } = await sb.from('cxp_revision').upsert(lote, { onConflict: 'doc_entry' });
      if (error) return reply(200, { ok: false, error: 'upsert: ' + error.message });
      escritas += lote.length;
    }
    // Borrar las que YA NO están abiertas en SAP (no se vieron en esta corrida).
    const stamp = hoy.toISOString();
    const { error: delErr } = await sb.from('cxp_revision').delete().lt('synced_at', stamp);
    if (delErr) return reply(200, { ok: false, error: 'limpieza: ' + delErr.message });

    return reply(200, { ok: true, empresa: empresa.nombreCorto, leidas: rows.length, guardadas: escritas });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
