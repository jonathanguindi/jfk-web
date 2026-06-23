// gastos-sync-background.js · Sincroniza los GASTOS de SAP (líneas de facturas de servicio a
// proveedores) a Supabase tabla gastos_sap, para el dashboard de análisis. Función BACKGROUND
// (202 inmediato, corre hasta ~15 min). Solo lectura de SAP. Dispara con token o como admin.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { sapLogin, sapGetAll } = require('./lib/sap-ventas');

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return { statusCode: 500, body: 'no supabase' };
    const token = process.env.VENTAS_SYNC_TOKEN || '';
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    const auth = (token && body.token === token) || (body.email && body.email.trim().toLowerCase() === adminEmail) || body.next_run;
    if (!auth) return { statusCode: 403, body: 'forbidden' };

    const prefijo = process.env.SAP_GASTO_PREFIX || '61';
    const itbmsAcct = process.env.SAP_ITBMS_ACCT || '610224';
    const anios = Math.min(8, Math.max(2, Number(body.anios) || 5));
    const desde = (new Date().getUTCFullYear() - anios + 1) + '-01-01';

    const cookie = await sapLogin();
    const cuentasRows = await sapGetAll(cookie, `ChartOfAccounts?$filter=startswith(Code,'${prefijo}')&$select=Code,Name`);
    const nombreCuenta = new Map((cuentasRows || []).map(c => [c.Code, c.Name]));

    const docs = await sapGetAll(cookie, `PurchaseInvoices?$filter=DocType eq 'dDocument_Service' and DocDate ge '${desde}'&$select=DocEntry,DocNum,DocDate,CardCode,CardName,DocumentLines&$orderby=DocEntry desc`);

    const filas = [];
    for (const d of (docs || [])) {
      const fecha = (d.DocDate || '').slice(0, 10); if (!fecha) continue;
      (d.DocumentLines || []).forEach((l, i) => {
        const code = l.AccountCode;
        if (!code || !String(code).startsWith(prefijo) || code === itbmsAcct) return;
        const monto = Number(l.LineTotal) || 0; if (!monto) return;
        filas.push({
          line_uid: `${d.DocEntry}|${l.LineNum != null ? l.LineNum : i}`,
          doc_entry: d.DocEntry, doc_num: d.DocNum != null ? d.DocNum : null, doc_date: fecha,
          card_code: d.CardCode || null, proveedor: d.CardName || null,
          account_code: code, account_name: nombreCuenta.get(code) || code,
          monto: Math.round(monto * 100) / 100,
          anio: Number(fecha.slice(0, 4)), mes: Number(fecha.slice(5, 7))
        });
      });
    }

    let escritas = 0;
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500);
      const { error } = await sb.from('gastos_sap').upsert(lote, { onConflict: 'line_uid' });
      if (error) return { statusCode: 200, body: JSON.stringify({ ok: false, error: error.message, escritas }) };
      escritas += lote.length;
    }
    // Borrar lo anterior al rango (limpieza)
    await sb.from('gastos_sap').delete().lt('doc_date', desde);

    return { statusCode: 200, body: JSON.stringify({ ok: true, empresa: empresa.nombreCorto, facturas: (docs || []).length, lineas: escritas, desde }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message || String(e) }) };
  }
};
