// netlify/functions/historial-cliente.js
// Trae el historial de compras de un cliente desde SAP.
// Recibe: { cardCode }
// Devuelve: array de productos comprados con stats (última qty, frecuencia, precio último)

const https = require('https');

const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
const SAP_USER = process.env.SAP_USER;
const SAP_PASS = process.env.SAP_PASSWORD;

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchSAP(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: options.method || 'GET', agent,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers }); }
          catch (e) { resolve({ status: res.statusCode, data: body, headers: res.headers }); }
        } else { reject(new Error(`SAP ${res.statusCode}: ${body}`)); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

async function login() {
  const r = await fetchSAP(`${SAP_URL}/Login`, {
    method: 'POST',
    body: { CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASS }
  });
  const cookies = r.headers['set-cookie'] || [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { cardCode } = JSON.parse(event.body || '{}');
    if (!cardCode) return { statusCode: 400, body: JSON.stringify({ error: 'cardCode requerido' }) };

    const cookie = await login();
    const productos = {};
    let skip = 0;

    while (true) {
      const url = `${SAP_URL}/Invoices?$filter=CardCode eq '${cardCode}'&$select=DocEntry,DocNum,DocDate,DocumentLines&$orderby=DocDate desc&$skip=${skip}`;
      const r = await fetchSAP(url, { headers: { Cookie: cookie, Prefer: 'odata.maxpagesize=20' } });
      const facturas = r.data.value || [];
      if (facturas.length === 0) break;

      for (const inv of facturas) {
        const fecha = inv.DocDate;
        const lineas = inv.DocumentLines || [];
        for (const linea of lineas) {
          const code = linea.ItemCode;
          if (!code) continue;
          const qty = parseFloat(linea.Quantity || 0);
          const price = parseFloat(linea.Price || 0);
          if (!productos[code]) {
            productos[code] = {
              item_code: code,
              item_description: linea.ItemDescription || '',
              qty_total: 0, qty_ultima: 0, qty_promedio: 0,
              fecha_ultima: fecha, precio_ultimo: price, veces_comprado: 0
            };
          }
          const p = productos[code];
          if (p.veces_comprado === 0) {
            p.qty_ultima = qty; p.fecha_ultima = fecha; p.precio_ultimo = price;
          }
          p.qty_total += qty;
          p.veces_comprado++;
        }
      }
      if (facturas.length < 20) break;
      skip += 20;
      if (skip > 1000) break; // tope de seguridad
    }

    // Calcular promedio
    for (const code in productos) {
      productos[code].qty_promedio = Math.round(productos[code].qty_total / productos[code].veces_comprado);
    }

    const arr = Object.values(productos).sort((a, b) => b.veces_comprado - a.veces_comprado);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, productos: arr, total: arr.length })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
