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
    const { cardCode, comments, lines } = payload;

    if (!cardCode || !lines || lines.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan datos: cardCode y lines son obligatorios' }) };
    }

    const cookies = await sapLogin();
    const hoy = new Date().toISOString().slice(0, 10);

    const orden = {
      CardCode: cardCode,
      DocDueDate: hoy,
      DocDate: hoy,
      Comments: comments || 'Pedido desde Portal JFK',
      DocumentLines: lines.map(l => {
        const line = { ItemCode: l.itemCode, Quantity: l.quantity };
        // Precio negociado en el pedido: UnitPrice SOBREESCRIBE la lista de precios del
        // cliente en SAP (antes se ignoraba y SAP aplicaba el precio de la lista = "precio Kennedy").
        const up = Number(l.unitPrice);
        if (l.unitPrice != null && up >= 0 && isFinite(up)) {
          line.UnitPrice = up;
        } else if (l.discountPercent && l.discountPercent > 0) {
          line.DiscountPercent = l.discountPercent;
        }
        return line;
      })
    };

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
