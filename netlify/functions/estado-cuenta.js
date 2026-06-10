// netlify/functions/estado-cuenta.js
// Estado de cuenta de un cliente leyendo Facturas, Pagos y Notas de Crédito de SAP.
// Recibe: { cardCode, desde, hasta }  (fechas YYYY-MM-DD)
// Devuelve: { cliente, movimientos[], saldoAnterior, saldoFinal, totalDebito, totalCredito, aging }
//
// CORRECCIONES:
//  1) Saldo corrido reconciliado contra el saldo real de SAP (CurrentAccountBalance):
//     se calcula un "Saldo anterior" = saldoActual - (debitos - creditos del rango),
//     de modo que la tabla termine exactamente en el saldo real.
//  2) Antigüedad (aging) por asignación FIFO: el saldo real se reparte sobre las facturas
//     más recientes (las viejas se asumen pagadas primero). Así SIEMPRE suma el saldo real
//     y no depende de PaidToDate (poco confiable cuando hay pagos a cuenta).

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

    // Documentos dentro del rango [desde, hasta]
    const invRes = await sapGet(cookies, `Invoices?$select=DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocumentStatus,Comments&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
    const payRes = await sapGet(cookies, `IncomingPayments?$select=DocNum,DocDate,CashSum,TransferSum,Remarks&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
    let cnRes = { value: [] };
    try {
      cnRes = await sapGet(cookies, `CreditNotes?$select=DocNum,DocDate,DocTotal,Comments&$filter=CardCode eq '${cardCode}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
    } catch (e) { /* algunas instalaciones no tienen, ignorar */ }

    // Movimientos unificados del rango
    const movs = [];
    (invRes.value || []).forEach(f => {
      movs.push({ fecha: f.DocDate ? f.DocDate.slice(0, 10) : '', tipo: 'FA', doc: f.DocNum, comentario: f.Comments || 'Factura', debito: f.DocTotal || 0, credito: 0 });
    });
    (payRes.value || []).forEach(p => {
      const monto = (p.CashSum || 0) + (p.TransferSum || 0);
      movs.push({ fecha: p.DocDate ? p.DocDate.slice(0, 10) : '', tipo: 'RC', doc: p.DocNum, comentario: p.Remarks || 'Pago recibido', debito: 0, credito: monto });
    });
    (cnRes.value || []).forEach(c => {
      movs.push({ fecha: c.DocDate ? c.DocDate.slice(0, 10) : '', tipo: 'NC', doc: c.DocNum, comentario: c.Comments || 'Nota de crédito', debito: 0, credito: c.DocTotal || 0 });
    });
    movs.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tipo.localeCompare(b.tipo));

    // Totales del rango
    let totalDebito = 0, totalCredito = 0;
    movs.forEach(m => { totalDebito += m.debito; totalCredito += m.credito; });
    totalDebito = r2(totalDebito);
    totalCredito = r2(totalCredito);

    // Saldo anterior reconciliado: lo que faltaba para llegar al saldo real de SAP
    const saldoAnterior = r2(saldoActual - (totalDebito - totalCredito));

    // Saldo corrido arrancando desde el saldo anterior
    let saldo = saldoAnterior;
    movs.forEach(m => { saldo = r2(saldo + m.debito - m.credito); m.saldo = saldo; });
    const saldoFinal = movs.length ? movs[movs.length - 1].saldo : saldoAnterior;

    // Lista final con fila "Saldo anterior" al inicio (si aplica)
    const movimientos = [];
    if (Math.abs(saldoAnterior) >= 0.01) {
      movimientos.push({ fecha: fechaDesde, tipo: '', doc: '', comentario: 'Saldo anterior', debito: 0, credito: 0, saldo: saldoAnterior });
    }
    movimientos.push(...movs);

    // ===== AGING (FIFO): repartir el saldo real sobre las facturas más recientes =====
    const hoy = new Date();
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-150': 0, '151-180': 0, '181-210': 0, '211-240': 0, 'mas240': 0 };
    const facturas = (invRes.value || []).slice()
      .sort((a, b) => (b.DocDate || '').localeCompare(a.DocDate || '')); // más recientes primero
    let restante = Math.max(saldoActual, 0);
    for (const f of facturas) {
      if (restante <= 0.005) break;
      const monto = Math.min(f.DocTotal || 0, restante);
      if (monto <= 0) continue;
      const venc = f.DocDueDate ? new Date(f.DocDueDate) : (f.DocDate ? new Date(f.DocDate) : hoy);
      const dias = Math.floor((hoy - venc) / 86400000);
      let b;
      if (dias <= 30) b = '0-30';
      else if (dias <= 60) b = '31-60';
      else if (dias <= 90) b = '61-90';
      else if (dias <= 120) b = '91-120';
      else if (dias <= 150) b = '121-150';
      else if (dias <= 180) b = '151-180';
      else if (dias <= 210) b = '181-210';
      else if (dias <= 240) b = '211-240';
      else b = 'mas240';
      buckets[b] = r2(buckets[b] + monto);
      restante = r2(restante - monto);
    }
    // Si quedó saldo sin cubrir por facturas (p.ej. saldo de apertura), va al bucket más viejo
    if (restante > 0.01) buckets['mas240'] = r2(buckets['mas240'] + restante);

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
        totalDebito,
        totalCredito,
        saldoFinal
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
