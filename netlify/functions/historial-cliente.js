// historial-cliente.js · historial de compras del cliente.
// AHORA lee de Supabase (tabla ventas_lineas, sincronizada cada noche desde SAP) en vez de
// consultar SAP en vivo: instantáneo y confiable (antes el portal de clientes se colgaba / salía 0
// por timeouts de SAP). Mantiene el MISMO formato de respuesta { ok, productos:[...] }.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const { cardCode, desde } = JSON.parse(event.body || '{}');
    if (!cardCode) return reply(200, { ok: false, error: 'cardCode requerido' });

    const sb = getSupabase(getEmpresa());
    if (!sb) return reply(200, { ok: false, error: 'Supabase no configurado' });

    const fechaDesde = (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) ? desde : '2018-01-01';

    // Traer líneas de FACTURA (compras) del cliente, más recientes primero. Paginado.
    let rows = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from('ventas_lineas')
        .select('doc_date,item_code,item_description,quantity,line_total')
        .eq('card_code', cardCode)
        .eq('doc_type', 'I')
        .gte('doc_date', fechaDesde)
        .order('doc_date', { ascending: false })
        .range(from, from + 999);
      const { data, error } = await q;
      if (error) return reply(200, { ok: false, error: error.message });
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
    }

    // Agregar por item (rows ya viene de más reciente a más antiguo).
    const agg = {};
    for (const l of rows) {
      const code = l.item_code; if (!code) continue;
      if (!agg[code]) agg[code] = { item_code: code, item_description: l.item_description || '', qty_total: 0, qty_ultima: 0, precio_ultimo: 0, fecha_ultima: '', _fechas: new Set() };
      const a = agg[code];
      const qty = Number(l.quantity) || 0;
      a.qty_total += qty;
      const f = (l.doc_date || '').slice(0, 10);
      if (f) a._fechas.add(f);
      if (!a.fecha_ultima) {   // primera vez que vemos el item = compra más reciente
        a.qty_ultima = qty;
        a.precio_ultimo = qty ? Math.round((Number(l.line_total) || 0) / qty * 10000) / 10000 : 0;
        a.fecha_ultima = f;
      }
    }
    const productos = Object.values(agg).map(a => {
      const veces = a._fechas.size;
      return {
        item_code: a.item_code, item_description: a.item_description,
        qty_total: a.qty_total, qty_ultima: a.qty_ultima,
        qty_promedio: veces ? Math.round((a.qty_total / veces) * 100) / 100 : 0,
        veces_comprado: veces, fecha_ultima: a.fecha_ultima, precio_ultimo: a.precio_ultimo
      };
    }).filter(p => p.qty_total > 0)
      .sort((x, y) => (y.fecha_ultima || '').localeCompare(x.fecha_ultima || ''));

    return reply(200, { ok: true, productos, _debug: { lineas: rows.length, items: productos.length, fuente: 'supabase', desde: fechaDesde } });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
