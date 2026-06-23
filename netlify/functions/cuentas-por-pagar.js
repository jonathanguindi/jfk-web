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
    // "Vigente/operativo" = factura emitida en los últimos N meses (configurable) y saldo >= $1.
    // El resto (docs viejísimos, posible intercompañía/basura SAP) va al bloque "histórico".
    const meses = Number(body.meses) > 0 ? Number(body.meses) : 18;
    const corte = new Date(hoy.getFullYear(), hoy.getMonth() - meses, hoy.getDate());

    let histTotal = 0, histFacturas = 0;                       // TODO lo abierto con saldo
    const vig = { total: 0, vencido: 0, porVencer: 0, aging: { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 } };
    const provMap = {};
    const facturas = [];

    for (const f of rows) {
      const saldo = (Number(f.DocTotal) || 0) - (Number(f.PaidToDate) || 0);
      if (saldo <= 0.01) continue;
      histTotal += saldo; histFacturas += 1;

      const fecha = f.DocDate ? new Date(f.DocDate.slice(0, 10) + 'T00:00:00') : null;
      const esVigente = saldo >= 1 && (!fecha || fecha >= corte);
      if (!esVigente) continue;   // los viejos solo cuentan en el histórico

      const due = f.DocDueDate ? new Date(f.DocDueDate.slice(0, 10) + 'T00:00:00') : null;
      const atraso = due ? dias(hoy, due) : 0;   // positivo = ya venció
      vig.total += saldo;
      if (atraso > 0) { vig.vencido += saldo; const a = vig.aging; if (atraso <= 30) a.d0_30 += saldo; else if (atraso <= 60) a.d31_60 += saldo; else if (atraso <= 90) a.d61_90 += saldo; else a.d90 += saldo; }
      else vig.porVencer += saldo;

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
      meses_vigente: meses,
      // Bloque VIGENTE (operativo)
      total_por_pagar: r2(vig.total),
      vencido: r2(vig.vencido),
      por_vencer: r2(vig.porVencer),
      num_facturas: facturas.length,
      num_proveedores: proveedores.length,
      aging: { d0_30: r2(vig.aging.d0_30), d31_60: r2(vig.aging.d31_60), d61_90: r2(vig.aging.d61_90), d90: r2(vig.aging.d90) },
      proveedores: proveedores.slice(0, 30),
      facturas: facturas.slice(0, 60),
      // Bloque HISTÓRICO (incluye docs antiguos / posible intercompañía)
      historico: { total: r2(histTotal), num_facturas: histFacturas },
      _debug: { leidas: rows.length }
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
