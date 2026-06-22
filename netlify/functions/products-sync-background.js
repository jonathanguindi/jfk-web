// products-sync-background.js
// Sincroniza el INVENTARIO (stock) de SAP -> tabla `products` de Supabase.
// Actualiza SOLO el stock de los productos que YA existen (no toca nombre, línea, medidas,
// precios, fotos, etc. — esos son curados). No crea productos nuevos.
// Background (hasta 15 min). Protegido por token. Disparo: POST {"token":"..."}.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { sapLogin, sapLogout, sapGetAll } = require('./lib/sap-ventas');

exports.handler = async (event) => {
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const token = body.token || (event.queryStringParameters && event.queryStringParameters.token) || '';
  const expected = process.env.VENTAS_SYNC_TOKEN;
  const esProgramado = !!body.next_run;
  if (expected && token !== expected && !esProgramado) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'token inválido' }) };
  }

  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Supabase no configurado' }) };

  let cookie;
  try {
    // 1) Códigos de productos que ya existen (solo esos se actualizan).
    const existentes = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('products').select('sap_item_code').range(from, from + 999);
      if (error) return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'leyendo products: ' + error.message }) };
      if (!data || !data.length) break;
      data.forEach(r => existentes.add(r.sap_item_code));
      if (data.length < 1000) break;
    }

    // 2) Stock desde SAP (Items.QuantityOnStock).
    cookie = await sapLogin();
    const items = await sapGetAll(cookie, 'Items?$select=ItemCode,QuantityOnStock').catch(() => []);
    await sapLogout(cookie); cookie = null;

    // 3) Filtrar a los que existen y armar filas {sap_item_code, stock}.
    const rows = (items || [])
      .filter(it => it && it.ItemCode && existentes.has(it.ItemCode))
      .map(it => ({ sap_item_code: it.ItemCode, stock: Math.round(Number(it.QuantityOnStock) || 0) }));

    // 4) Upsert por lotes (solo actualiza la columna stock de filas existentes).
    let actualizados = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('products').upsert(chunk, { onConflict: 'sap_item_code' });
      if (error) return { statusCode: 200, body: JSON.stringify({ ok: false, error: error.message, actualizados }) };
      actualizados += chunk.length;
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, itemsSAP: (items || []).length, productosExistentes: existentes.size, actualizados }) };
  } catch (e) {
    if (cookie) { try { await sapLogout(cookie); } catch (_) {} }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
