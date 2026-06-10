// netlify/functions/estado-cuenta.js
// Genera el estado de cuenta de un cliente leyendo Facturas, Pagos y Notas de Crédito de SAP.
// Recibe: { cardCode, desde, hasta }  (fechas YYYY-MM-DD)
// Devuelve: { cliente, movimientos[], saldoAnterior, saldoFinal, totalDebito, totalCredito, aging }
//
// CORRECCIONES:
//  1) El saldo corrido ahora arranca desde el "saldo anterior" reconciliado contra el saldo
//     real de SAP (CurrentAccountBalance). Antes arrancaba en 0 y no cuadraba.
//  2) La antigüedad (aging) solo considera facturas realmente ABIERTAS (DocumentStatus open),
//     evitando contar facturas canceladas/cerradas que tenían PaidToDate = 0.

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASSWORD;

async function sapLogin() {
  const res = await fetch(`${SAP_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASS }),
    agent
  });
  if (!res.ok) throw new Error(`SAP login falló: ${res.status}`);
  const setCookie = res.headers.raw ? res.headers.raw()['set-cookie'] : res.headers.get('set-cookie');
  return Array.isArray(setCookie)
    ? setCookie.map(c => c.split(';')[0]).join('; ')
    : setCookie.split(',').map(c => c.split(';')[0]).join('; ');
}

async function sapGet(cookies, path) {
  const res = await fetch(`${SAP_URL}/${path}`, {
    method: 'GET',
    headers: { 'Cookie': cookies, 'Content-Type': 'application/json', 'Prefer': 'odata.maxpagesize=0' },
    agent
  });
  if (!res.ok) throw new Error(`SAP error ${res.status} en ${path}: ${await res.text()}`);
  return res.json();
}

const r2 = (n) => Math.round((n || 0) * 100) / 100;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  try {
    const { cardCode, desde, hasta } = JSON.parse(event.body || '{}');
    if (!cardCode) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta cardCode' }) };

    const fechaDesde = desde || '2024-01-01';
    const fechaHasta = hasta || new Date().toISOString().slice(0, 10);

    const cookies = await sapLogin();

    // Datos del cliente (incluye el saldo real actual de SAP)
    const bp = await sapGet(cookies, `BusinessPartners('${cardCode}')?$select=CardCode,CardName,CurrentAccountBalance,Country,Phone1,Cellular,EmailAddress,CreditLimit`);
    const saldoActual = r2(bp.CurrentAccountBalance);

    // === Documentos DESDE la fecha inicial HASTA HOY (sin tope superior) ===
    // Necesitamos todo desde 'desde' hasta hoy para poder reconciliar el saldo
    // contra el saldo real de SAP. Luego mostramos solo el rango pedido.
    const invRes = await sapGet(cookies, `Invoices?$select=DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocumentStatus,Comments&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}'&$orderby=DocDate`);
    const payRes = await sapGet(cookies, `IncomingPayments?$select=DocNum,DocDate,CashSum,TransferSum,Remarks&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}'&$orderby=DocDate`);
    let cnRes = { value: [] };
    try {
      cnRes = await sapGet(cookies, `CreditNotes?$select=DocNum,DocDate,DocTotal,Comments&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}'&$orderby=DocDate`);
    } catch (e) { /* algunas instalaciones no tienen, ignorar */ }

    // Construir movimientos unificados (desde la fecha inicial hasta hoy)
    const todos = [];

    (invRes.value || []).forEach(f => {
      todos.push({
        fecha: f.DocDate ? f.DocDate.slice(0, 10) : '',
        tipo: 'FA',
        doc: f.DocNum,
        comentario: f.Comments || 'Factura',
        debito: f.DocTotal || 0,
        credito: 0
      });
    });

    (payRes.value || []).forEach(p => {
      const monto = (p.CashSum || 0) + (p.TransferSum || 0);
      todos.push({
        fecha: p.DocDate ? p.DocDate.slice(0, 10) : '',
        tipo: 'RC',
        doc: p.DocNum,
        comentario: p.Remarks || 'Pago recibido',
        debito: 0,
        credito: monto
      });
    });

    (cnRes.value || []).forEach(c => {
      todos.push({
        fecha: c.DocDate ? c.DocDate.slice(0, 10) : '',
        tipo: 'NC',
        doc: c.DocNum,
        comentario: c.Comments || 'Nota de crédito',
        debito: 0,
        credito: c.DocTotal || 0
      });
    });

    // Ordenar cronológicamente (FA/NC/RC como desempate estable)
    todos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tipo.localeCompare(b.tipo));

    // === Saldo anterior (al inicio del rango) ===
    // saldoActual = saldoAnterior + neto(todos los docs desde 'desde' hasta hoy)
    // => saldoAnterior = saldoActual - neto
    let netoTodo = 0;
    todos.forEach(m => { netoTodo += m.debito - m.credito; });
    const saldoAnterior = r2(saldoActual - netoTodo);

    // Saldo corrido arrancando desde el saldo anterior
    let saldo = saldoAnterior;
    todos.forEach(m => { saldo = r2(saldo + m.debito - m.credito); m.saldo = saldo; });

    // Mostrar solo los movimientos dentro del rango [desde, hasta]
    const visibles = todos.filter(m => m.fecha <= fechaHasta);

    // Totales del rango visible
    let totalDebito = 0, totalCredito = 0;
    visibles.forEach(m => { totalDebito += m.debito; totalCredito += m.credito; });
    const saldoFinal = visibles.length ? visibles[visibles.length - 1].saldo : saldoAnterior;

    // Armar lista final con una fila de "Saldo anterior" al inicio (si hay)
    const movimientos = [];
    if (Math.abs(saldoAnterior) >= 0.01) {
      movimientos.push({
        fecha: fechaDesde,
        tipo: '',
        doc: '',
        comentario: 'Saldo anterior',
        debito: 0,
        credito: 0,
        saldo: saldoAnterior
      });
    }
    movimientos.push(...visibles);

    // ===== AGING: solo facturas realmente ABIERTAS (todas, sin filtro de fecha) =====
    const hoy = new Date();
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-150': 0, '151-180': 0, '181-210': 0, '211-240': 0, 'mas240': 0 };
    let openInv = { value: [] };
    try {
      openInv = await sapGet(cookies, `Invoices?$select=DocTotal,PaidToDate,DocDueDate,DocDate&$filter=CardCode eq '${cardCode}' and DocumentStatus eq 'bost_Open'&$orderby=DocDate`);
    } catch (e) { /* ignorar */ }

    (openInv.value || []).forEach(f => {
      const pendiente = r2((f.DocTotal || 0) - (f.PaidToDate || 0));
      if (pendiente <= 0) return; // nada pendiente real
      const venc = f.DocDueDate ? new Date(f.DocDueDate) : (f.DocDate ? new Date(f.DocDate) : hoy);
      const dias = Math.floor((hoy - venc) / 86400000);
      let bucket;
      if (dias <= 30) bucket = '0-30';
      else if (dias <= 60) bucket = '31-60';
      else if (dias <= 90) bucket = '61-90';
      else if (dias <= 120) bucket = '91-120';
      else if (dias <= 150) bucket = '121-150';
      else if (dias <= 180) bucket = '151-180';
      else if (dias <= 210) bucket = '181-210';
      else if (dias <= 240) bucket = '211-240';
      else bucket = 'mas240';
      buckets[bucket] += pendiente;
    });
    Object.keys(buckets).forEach(k => { buckets[k] = r2(buckets[k]); });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        cliente: {
          codigo: bp.CardCode,
          nombre: bp.CardName,
          pais: bp.Country,
          telefono: bp.Phone1,
          celular: bp.Cellular,
          email: bp.EmailAddress,
          limiteCredito: bp.CreditLimit,
          saldoActual
        },
        rango: { desde: fechaDesde, hasta: fechaHasta },
        saldoAnterior,
        movimientos,
        aging: buckets,
        totalDebito: r2(totalDebito),
        totalCredito: r2(totalCredito),
        saldoFinal
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
