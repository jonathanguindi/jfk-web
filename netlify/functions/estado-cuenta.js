// netlify/functions/estado-cuenta.js
// Genera el estado de cuenta de un cliente leyendo Facturas, Pagos y Notas de Crédito de SAP.
// Recibe: { cardCode, desde, hasta }  (fechas YYYY-MM-DD)
// Devuelve: { cliente, movimientos[], saldoFinal, totalDebito, totalCredito }

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

    // Datos del cliente
    const bp = await sapGet(cookies, `BusinessPartners('${cardCode}')?$select=CardCode,CardName,CurrentAccountBalance,Country,Phone1,Cellular,EmailAddress,CreditLimit`);

    // Facturas en el rango
    const invRes = await sapGet(cookies, `Invoices?$select=DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocumentStatus,Comments&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);

    // Pagos en el rango
    const payRes = await sapGet(cookies, `IncomingPayments?$select=DocNum,DocDate,CashSum,TransferSum,Remarks&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);

    // Notas de crédito en el rango
    let cnRes = { value: [] };
    try {
      cnRes = await sapGet(cookies, `CreditNotes?$select=DocNum,DocDate,DocTotal,Comments&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
    } catch (e) { /* algunas instalaciones no tienen, ignorar */ }

    // Construir movimientos unificados
    const movimientos = [];

    (invRes.value || []).forEach(f => {
      movimientos.push({
        fecha: f.DocDate ? f.DocDate.slice(0, 10) : '',
        tipo: 'FA',
        doc: f.DocNum,
        comentario: f.Comments || 'Factura',
        debito: f.DocTotal || 0,
        credito: 0,
        abierta: f.DocumentStatus === 'bost_Open'
      });
    });

    (payRes.value || []).forEach(p => {
      const monto = (p.CashSum || 0) + (p.TransferSum || 0);
      movimientos.push({
        fecha: p.DocDate ? p.DocDate.slice(0, 10) : '',
        tipo: 'RC',
        doc: p.DocNum,
        comentario: p.Remarks || 'Pago recibido',
        debito: 0,
        credito: monto,
        abierta: false
      });
    });

    (cnRes.value || []).forEach(c => {
      movimientos.push({
        fecha: c.DocDate ? c.DocDate.slice(0, 10) : '',
        tipo: 'NC',
        doc: c.DocNum,
        comentario: c.Comments || 'Nota de crédito',
        debito: 0,
        credito: c.DocTotal || 0,
        abierta: false
      });
    });

    // Ordenar cronológicamente
    movimientos.sort((a, b) => a.fecha.localeCompare(b.fecha));

    // Calcular saldo corrido
    let saldo = 0, totalDebito = 0, totalCredito = 0;
    movimientos.forEach(m => {
      saldo += m.debito - m.credito;
      m.saldo = Math.round(saldo * 100) / 100;
      totalDebito += m.debito;
      totalCredito += m.credito;
    });

    // ===== AGING: clasificar el saldo pendiente por antigüedad =====
    // Usa las facturas ABIERTAS (no pagadas) y los días desde su vencimiento
    const hoy = new Date();
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-150': 0, '151-180': 0, '181-210': 0, '211-240': 0, 'mas240': 0 };
    (invRes.value || []).forEach(f => {
      const pendiente = (f.DocTotal || 0) - (f.PaidToDate || 0);
      if (pendiente <= 0) return; // ya pagada
      const venc = f.DocDueDate ? new Date(f.DocDueDate) : (f.DocDate ? new Date(f.DocDate) : hoy);
      const dias = Math.floor((hoy - venc) / (1000 * 60 * 60 * 24));
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
    // Redondear buckets
    Object.keys(buckets).forEach(k => { buckets[k] = Math.round(buckets[k] * 100) / 100; });

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
          saldoActual: bp.CurrentAccountBalance
        },
        rango: { desde: fechaDesde, hasta: fechaHasta },
        movimientos,
        aging: buckets,
        totalDebito: Math.round(totalDebito * 100) / 100,
        totalCredito: Math.round(totalCredito * 100) / 100,
        saldoFinal: Math.round(saldo * 100) / 100
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
