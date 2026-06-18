// netlify/functions/lib/sap-estado.js
// Núcleo reutilizable del estado de cuenta de un cliente (lee SAP Service Layer).
// Lo usan:  estado-cuenta.js (consulta del portal),  enviar-estado-cuenta.js (PDF + correo)
// y  cobranzas-job.js (cálculo de mora para el envío automático).
//
// Misma lógica que la función original estado-cuenta.js:
//  - Saldo anterior reconciliado contra el saldo real de SAP (CurrentAccountBalance).
//  - Antigüedad (aging) por asignación FIFO sobre las facturas más recientes.
// Adiciones para cobranzas:
//  - `vencido`   = monto del saldo real que ya pasó su fecha de vencimiento (DocDueDate < hoy).
//  - `maxAtraso` = días de atraso de la factura vencida más antigua que aún tiene saldo.
//                  (sirve para decidir la cadencia: 1-30 = semanal, >30 = diario)

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
// Soportamos los alias de Big Dream (SAP_USERNAME) además de los de JFK (SAP_USER).
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME;
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

// Devuelve el mismo objeto que entregaba estado-cuenta.js (cliente, movimientos, aging, etc.)
// más los campos de cobranzas (vencido, maxAtraso).  Recibe opcionalmente `hoy` (Date) para tests.
async function computeEstadoCuenta({ cardCode, desde, hasta }, hoy = new Date()) {
  if (!cardCode) throw new Error('Falta cardCode');

  const cc = String(cardCode).replace(/'/g, "''");
  const fechaDesde = desde || '2024-01-01';
  const fechaHasta = hasta || hoy.toISOString().slice(0, 10);

  const cookies = await sapLogin();

  // Datos del cliente (incluye el saldo real actual de SAP)
  const bp = await sapGet(cookies, `BusinessPartners('${cc}')?$select=CardCode,CardName,CurrentAccountBalance,Country,Phone1,Cellular,EmailAddress,CreditLimit`);
  const saldoActual = r2(bp.CurrentAccountBalance);

  // Documentos dentro del rango [desde, hasta]
  const invRes = await sapGet(cookies, `Invoices?$select=DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocumentStatus,Comments,SalesPersonCode&$filter=CardCode eq '${cc}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
  const payRes = await sapGet(cookies, `IncomingPayments?$select=DocNum,DocDate,CashSum,TransferSum,Remarks&$filter=CardCode eq '${cc}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
  let cnRes = { value: [] };
  try {
    cnRes = await sapGet(cookies, `CreditNotes?$select=DocNum,DocDate,DocTotal,Comments&$filter=CardCode eq '${cc}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate`);
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
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-150': 0, '151-180': 0, '181-210': 0, '211-240': 0, 'mas240': 0 };
  const facturas = (invRes.value || []).slice()
    .sort((a, b) => (b.DocDate || '').localeCompare(a.DocDate || '')); // más recientes primero
  let restante = Math.max(saldoActual, 0);
  let vencido = 0;          // monto del saldo real que ya venció (dias > 0)
  let maxAtraso = 0;        // días de atraso de la factura vencida más antigua con saldo
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
    if (dias > 0) {                       // factura ya vencida (pasó su DocDueDate)
      vencido = r2(vencido + monto);
      if (dias > maxAtraso) maxAtraso = dias;
    }
    restante = r2(restante - monto);
  }
  // Si quedó saldo sin cubrir por facturas (p.ej. saldo de apertura), va al bucket más viejo
  if (restante > 0.01) {
    buckets['mas240'] = r2(buckets['mas240'] + restante);
    vencido = r2(vencido + restante);     // saldo de apertura se asume vencido
  }

  // Días de crédito acordados = DocDueDate - DocDate de la factura más reciente.
  let diasCredito = null;
  for (const f of facturas) {
    if (f.DocDate && f.DocDueDate) {
      const dd = Math.round((new Date(f.DocDueDate) - new Date(f.DocDate)) / 86400000);
      if (dd >= 0) { diasCredito = dd; break; }
    }
  }

  // Vendedor de la última factura (para CC de seguimiento)
  let vendedor = null;
  const vCode = facturas.length ? facturas[0].SalesPersonCode : null;
  if (vCode != null && vCode > 0) {
    try {
      const sp = await sapGet(cookies, `SalesPersons(${vCode})?$select=SalesEmployeeCode,SalesEmployeeName`);
      vendedor = { code: vCode, nombre: sp.SalesEmployeeName || null };
    } catch (e) { vendedor = { code: vCode, nombre: null }; }
  }

  return {
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
    saldoFinal,
    // Campos de cobranzas
    vencido,
    maxAtraso,
    diasCredito,
    vendedor
  };
}

// Trae las facturas del rango CON sus líneas (para el PDF de facturas con fotos).
// Limita a `max` (más recientes primero) para no traer demasiado.
async function fetchFacturasConLineas({ cardCode, desde, hasta, max = 40 }) {
  const cc = String(cardCode).replace(/'/g, "''");
  const fechaDesde = desde || '2024-01-01';
  const fechaHasta = hasta || new Date().toISOString().slice(0, 10);
  const cookies = await sapLogin();
  const path = `Invoices?$select=DocNum,DocDate,DocDueDate,DocTotal,DocCurrency,DocumentLines&$filter=CardCode eq '${cc}' and DocDate ge '${fechaDesde}' and DocDate le '${fechaHasta}'&$orderby=DocDate desc`;
  const res = await fetch(`${SAP_URL}/${path}`, {
    method: 'GET',
    headers: { 'Cookie': cookies, 'Content-Type': 'application/json', 'Prefer': `odata.maxpagesize=${max}` },
    agent
  });
  if (!res.ok) throw new Error(`SAP Invoices(lineas) ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.value || []).slice(0, max).map(f => ({
    docNum: f.DocNum,
    fecha: (f.DocDate || '').slice(0, 10),
    venc: (f.DocDueDate || '').slice(0, 10),
    total: f.DocTotal,
    moneda: f.DocCurrency,
    lineas: (f.DocumentLines || []).map(l => ({
      code: l.ItemCode,
      desc: l.ItemDescription,
      qty: l.Quantity,
      precio: (l.Price != null ? l.Price : l.UnitPrice),
      total: l.LineTotal
    }))
  }));
}

module.exports = { computeEstadoCuenta, fetchFacturasConLineas };
