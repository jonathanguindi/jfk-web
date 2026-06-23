// cliente-dashboard.js · Dashboard 360° de un cliente para el portal de ventas.
// Lee de Supabase (ventas_lineas sincronizado de noche) + saldo (customers): instantáneo.
// Devuelve: resumen de compras, facturas, devoluciones, productos comprados (para grid con fotos),
// y ALERTAS: lo que debe (cartera), productos que dejó de comprar, caída en compras, devoluciones.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const diasEntre = (a, b) => Math.round((a - b) / 86400000);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const { cardCode } = JSON.parse(event.body || '{}');
    if (!cardCode) return reply(200, { ok: false, error: 'cardCode requerido' });

    const sb = getSupabase(getEmpresa());
    if (!sb) return reply(200, { ok: false, error: 'Supabase no configurado' });

    // 1) Todas las líneas del cliente (facturas 'I' y notas de crédito 'C'), recientes primero.
    let rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('ventas_lineas')
        .select('doc_type,doc_num,doc_date,item_code,item_description,item_group_name,quantity,line_total')
        .eq('card_code', cardCode)
        .gte('doc_date', '2018-01-01')
        .order('doc_date', { ascending: false })
        .range(from, from + 999);
      if (error) return reply(200, { ok: false, error: error.message });
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
    }

    const hoy = new Date();
    const facturasMap = {};      // doc_num -> { doc_num, doc_date, total, items }
    const devolucionesMap = {};  // doc_num -> { doc_num, doc_date, total, items }
    const prodMap = {};          // item_code -> agregado de COMPRAS (solo 'I')
    let totalComprado = 0, totalDevuelto = 0;
    let comprado180 = 0, compradoPrev180 = 0;   // para caída en compras

    for (const l of rows) {
      const f = (l.doc_date || '').slice(0, 10);
      const fd = f ? new Date(f + 'T00:00:00') : null;
      const monto = Number(l.line_total) || 0;   // 'I' positivo, 'C' negativo (ya viene con signo)
      const qty = Number(l.quantity) || 0;
      const key = (l.doc_num != null ? String(l.doc_num) : (f + '|' + (l.item_group_name || '')));

      if (l.doc_type === 'C') {
        totalDevuelto += Math.abs(monto);
        const d = devolucionesMap[key] || (devolucionesMap[key] = { doc_num: l.doc_num, doc_date: f, total: 0, items: 0 });
        d.total += Math.abs(monto); d.items += 1;
        continue;
      }
      // doc_type 'I' (factura / compra)
      totalComprado += monto;
      const fac = facturasMap[key] || (facturasMap[key] = { doc_num: l.doc_num, doc_date: f, total: 0, items: 0 });
      fac.total += monto; fac.items += 1;

      if (fd) {
        const dd = diasEntre(hoy, fd);
        if (dd >= 0 && dd < 180) comprado180 += monto;
        else if (dd >= 180 && dd < 360) compradoPrev180 += monto;
      }

      const code = l.item_code; if (!code) continue;
      const a = prodMap[code] || (prodMap[code] = { item_code: code, item_description: l.item_description || '', item_group_name: l.item_group_name || '', qty_total: 0, monto_total: 0, veces: new Set(), fecha_ultima: '', qty_ultima: 0, precio_ultimo: 0 });
      a.qty_total += qty; a.monto_total += monto;
      if (f) a.veces.add(f);
      if (!a.fecha_ultima) {   // primera aparición = compra más reciente (rows viene desc)
        a.fecha_ultima = f; a.qty_ultima = qty;
        a.precio_ultimo = qty ? r2(monto / qty) : 0;
      }
    }

    const productos = Object.values(prodMap).map(a => ({
      item_code: a.item_code, item_description: a.item_description, item_group_name: a.item_group_name,
      qty_total: r2(a.qty_total), monto_total: r2(a.monto_total),
      veces_comprado: a.veces.size, fecha_ultima: a.fecha_ultima,
      qty_ultima: a.qty_ultima, precio_ultimo: a.precio_ultimo
    })).filter(p => p.qty_total > 0)
      .sort((x, y) => (y.fecha_ultima || '').localeCompare(x.fecha_ultima || ''));

    const facturas = Object.values(facturasMap).map(f => ({ ...f, total: r2(f.total) }))
      .sort((a, b) => (b.doc_date || '').localeCompare(a.doc_date || ''));
    const devoluciones = Object.values(devolucionesMap).map(d => ({ ...d, total: r2(d.total) }))
      .sort((a, b) => (b.doc_date || '').localeCompare(a.doc_date || ''));

    const fechas = facturas.map(f => f.doc_date).filter(Boolean);
    const primeraCompra = fechas.length ? fechas[fechas.length - 1] : '';
    const ultimaCompra = fechas.length ? fechas[0] : '';
    const diasSinComprar = ultimaCompra ? diasEntre(hoy, new Date(ultimaCompra + 'T00:00:00')) : null;

    // ALERTA 1: lo que debe (cartera) — saldo de la tabla customers (rápido).
    let saldo = 0, saldoNombre = '';
    try {
      const { data: cust } = await sb.from('customers').select('current_balance,name').eq('sap_card_code', cardCode).limit(1);
      if (cust && cust[0]) { saldo = Number(cust[0].current_balance) || 0; saldoNombre = cust[0].name || ''; }
    } catch (e) { /* sin saldo: no rompe */ }

    // ALERTA 2: productos que dejó de comprar (compraba >=2 veces y hace >120 días que no pide).
    const dejoDeComprar = productos
      .filter(p => p.veces_comprado >= 2 && p.fecha_ultima && diasEntre(hoy, new Date(p.fecha_ultima + 'T00:00:00')) > 120)
      .map(p => ({ ...p, dias_sin: diasEntre(hoy, new Date(p.fecha_ultima + 'T00:00:00')) }))
      .sort((a, b) => b.monto_total - a.monto_total)
      .slice(0, 12);

    // ALERTA 3: caída en compras (últimos 180 días vs los 180 previos).
    const caidaPct = compradoPrev180 > 0 ? Math.round((1 - comprado180 / compradoPrev180) * 100) : 0;
    const hayCaida = compradoPrev180 > 0 && comprado180 < compradoPrev180 * 0.65;

    return reply(200, {
      ok: true,
      resumen: {
        total_comprado: r2(totalComprado),
        num_facturas: facturas.length,
        num_productos: productos.length,
        ticket_promedio: facturas.length ? r2(totalComprado / facturas.length) : 0,
        primera_compra: primeraCompra,
        ultima_compra: ultimaCompra,
        dias_sin_comprar: diasSinComprar,
        comprado_180: r2(comprado180),
        comprado_180_prev: r2(compradoPrev180)
      },
      alertas: {
        debe: { saldo: r2(saldo), tiene: saldo > 0.5 },
        caida: { hay: hayCaida, pct: caidaPct, recientes: r2(comprado180), previos: r2(compradoPrev180) },
        devoluciones: { count: devoluciones.length, total: r2(totalDevuelto), tiene: devoluciones.length > 0 },
        dejo_de_comprar: dejoDeComprar
      },
      facturas: facturas.slice(0, 50),
      devoluciones: devoluciones.slice(0, 30),
      productos,
      _debug: { lineas: rows.length, cliente: saldoNombre, fuente: 'supabase' }
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
