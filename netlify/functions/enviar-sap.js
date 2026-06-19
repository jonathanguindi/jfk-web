// netlify/functions/enviar-sap.js
// Crea una Orden de Venta en SAP B1 desde el portal de vendedores.
// Las credenciales SAP vienen de variables de entorno de Netlify (seguras).

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
  if (!res.ok) throw new Error(`SAP login falló: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.raw ? res.headers.raw()['set-cookie'] : res.headers.get('set-cookie');
  const cookies = Array.isArray(setCookie)
    ? setCookie.map(c => c.split(';')[0]).join('; ')
    : setCookie.split(',').map(c => c.split(';')[0]).join('; ');
  return cookies;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const { cardCode, comments, lines, salesPersonCode, orderRef } = payload;

    if (!cardCode || !lines || lines.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan datos: cardCode y lines son obligatorios' }) };
    }
    // Validar cantidades: ninguna línea con cantidad <= 0 o inválida.
    const malQty = lines.filter(l => !(Number(l.quantity) > 0));
    if (malQty.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Hay líneas con cantidad inválida (debe ser mayor a 0).' }) };
    }

    const cookies = await sapLogin();
    const hoy = new Date().toISOString().slice(0, 10);

    // ANTI-DUPLICADO: si ya existe una orden con este orderRef (NumAtCard), devolverla
    // en vez de crear otra (evita duplicados si el vendedor reintenta tras un timeout).
    if (orderRef) {
      try {
        const ref = String(orderRef).replace(/'/g, "''");
        const chk = await fetch(`${SAP_URL}/Orders?$select=DocEntry,DocNum,CardName,DocTotal&$filter=NumAtCard eq '${ref}'&$top=1`, { headers: { 'Cookie': cookies, 'Content-Type': 'application/json' }, agent });
        if (chk.ok) {
          const cj = await chk.json();
          if (cj.value && cj.value.length) {
            const d0 = cj.value[0];
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, duplicate: true, docEntry: d0.DocEntry, docNum: d0.DocNum, cardName: d0.CardName, docTotal: d0.DocTotal }) };
          }
        }
      } catch (e) { /* si la verificación falla, seguimos y creamos normal */ }
    }

    const orden = {
      CardCode: cardCode,
      DocDueDate: hoy,
      DocDate: hoy,
      Comments: comments || 'Pedido desde Portal JFK',
      DocumentLines: lines.map(l => {
        const line = { ItemCode: l.itemCode, Quantity: l.quantity };
        // Precio negociado en el pedido: UnitPrice SOBREESCRIBE la lista del cliente en SAP.
        // OJO: solo si es > 0. Un precio 0/nulo NO se envía (SAP usaría su lista) para
        // evitar crear órdenes a precio CERO (regalar producto).
        const up = Number(l.unitPrice);
        if (l.unitPrice != null && isFinite(up) && up > 0) {
          line.UnitPrice = up;
        } else if (l.discountPercent && l.discountPercent > 0) {
          line.DiscountPercent = l.discountPercent;
        }
        return line;
      })
    };
    // Atribuir la orden al vendedor en SAP (antes iba sin SalesPersonCode → métricas mal atribuidas).
    const spc = Number(salesPersonCode);
    if (salesPersonCode != null && Number.isInteger(spc) && spc > 0) orden.SalesPersonCode = spc;
    // Referencia única para el anti-duplicado.
    if (orderRef) orden.NumAtCard = String(orderRef).slice(0, 100);

    const res = await fetch(`${SAP_URL}/Orders`, {
      method: 'POST',
      headers: { 'Cookie': cookies, 'Content-Type': 'application/json' },
      body: JSON.stringify(orden),
      agent
    });

    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error.message.value; } catch (e) {}
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'SAP rechazó la orden: ' + msg }) };
    }

    const data = JSON.parse(text);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        docEntry: data.DocEntry,
        docNum: data.DocNum,
        cardName: data.CardName,
        docTotal: data.DocTotal
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
