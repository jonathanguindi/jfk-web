// cuentas-por-pagar.js · Lee de SAP (Service Layer) las facturas de compra ABIERTAS = lo que la
// empresa debe a sus proveedores (cuentas por pagar). SOLO LECTURA, SOLO ADMIN.
// Devuelve: total por pagar, vencido vs por vencer, aging (0-30/31-60/61-90/90+),
// top proveedores y una muestra de facturas. No escribe nada en SAP.
const { getEmpresa } = require('./lib/empresa-config');
const { sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dias = (a, b) => Math.round((a - b) / 86400000);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    const email = (body.email || '').trim().toLowerCase();
    if (!adminEmail || email !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();

    // Facturas de compra ABIERTAS (lo que se debe). DocumentStatus bost_Open = abierta.
    // Saldo de cada factura = DocTotal - PaidToDate.
    const path = "PurchaseInvoices?$select=DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,PaidToDate,DocCurrency,DocumentStatus&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocDueDate asc";
    const rows = await sapGetAll(cookie, path);

    const hoy = new Date();
    let total = 0, vencido = 0, porVencer = 0;
    const aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    const provMap = {};
    const facturas = [];

    for (const f of rows) {
      const saldo = (Number(f.DocTotal) || 0) - (Number(f.PaidToDate) || 0);
      if (saldo <= 0.01) continue;
      total += saldo;
      const due = f.DocDueDate ? new Date(f.DocDueDate.slice(0, 10) + 'T00:00:00') : null;
      const atraso = due ? dias(hoy, due) : 0;   // positivo = ya venció
      if (atraso > 0) { vencido += saldo; if (atraso <= 30) aging.d0_30 += saldo; else if (atraso <= 60) aging.d31_60 += saldo; else if (atraso <= 90) aging.d61_90 += saldo; else aging.d90 += saldo; }
      else porVencer += saldo;

      const k = f.CardCode || '?';
      const p = provMap[k] || (provMap[k] = { card_code: k, name: f.CardName || k, saldo: 0, facturas: 0, vencido: 0 });
      p.saldo += saldo; p.facturas += 1; if (atraso > 0) p.vencido += saldo;

      facturas.push({ doc_num: f.DocNum, proveedor: f.CardName || k, card_code: k, fecha: (f.DocDate || '').slice(0, 10), vence: (f.DocDueDate || '').slice(0, 10), saldo: r2(saldo), atraso, moneda: f.DocCurrency || '' });
    }

    const proveedores = Object.values(provMap).map(p => ({ ...p, saldo: r2(p.saldo), vencido: r2(p.vencido) }))
      .sort((a, b) => b.saldo - a.saldo);
    facturas.sort((a, b) => (a.vence || '9999').localeCompare(b.vence || '9999'));

    return reply(200, {
      ok: true,
      empresa: empresa.nombreCorto,
      total_por_pagar: r2(total),
      vencido: r2(vencido),
      por_vencer: r2(porVencer),
      num_facturas: facturas.length,
      num_proveedores: proveedores.length,
      aging: { d0_30: r2(aging.d0_30), d31_60: r2(aging.d31_60), d61_90: r2(aging.d61_90), d90: r2(aging.d90) },
      proveedores: proveedores.slice(0, 30),
      facturas: facturas.slice(0, 60),
      _debug: { leidas: rows.length, abiertas_con_saldo: facturas.length }
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
