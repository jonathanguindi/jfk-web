// gastos-analisis.js · Analiza los GASTOS desde Supabase (tabla gastos_sap, sincronizada de SAP).
// SOLO LECTURA, SOLO ADMIN. Rápido. Devuelve totales por año, top categorías, tendencia y
// comparativo año actual vs anterior (qué subió/bajó) para el dashboard.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    // Traer todas las líneas (paginado)
    let rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('gastos_sap').select('doc_date,account_code,account_name,monto,anio,mes,proveedor').range(from, from + 999);
      if (error) return reply(200, { ok: false, error: error.message });
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
    }

    if (!rows.length) return reply(200, { ok: true, vacio: true, mensaje: 'Sin datos de gastos. Dale "Actualizar desde SAP" para sincronizar.' });

    const anioActual = new Date().getUTCFullYear();
    const anioPrev = anioActual - 1;
    const mesActual = new Date().getUTCMonth() + 1;   // para comparar MISMO período (YTD)
    const porAnio = {}, porCuentaAnio = {}, tendencia = {}, porProvAnio = {};
    for (const l of rows) {
      const a = l.anio, monto = Number(l.monto) || 0, ym = (l.doc_date || '').slice(0, 7);
      const ytd = (Number(l.mes) || 0) <= mesActual;   // dentro del mismo período del año
      porAnio[a] = (porAnio[a] || 0) + monto;
      const code = l.account_code;
      const ca = porCuentaAnio[code] || (porCuentaAnio[code] = { nombre: l.account_name || code, anios: {}, ytdAct: 0, ytdPrev: 0 });
      ca.anios[a] = (ca.anios[a] || 0) + monto;
      if (a === anioActual && ytd) ca.ytdAct += monto;
      if (a === anioPrev && ytd) ca.ytdPrev += monto;
      if (ym) tendencia[ym] = (tendencia[ym] || 0) + monto;
      const prov = l.proveedor || '—';
      const pa = porProvAnio[prov] || (porProvAnio[prov] = { act: 0 });
      if (a === anioActual) pa.act += monto;
    }

    // Comparativo a MISMO período (enero–mes actual de ambos años) = justo.
    const categorias = Object.entries(porCuentaAnio).map(([code, o]) => {
      const act = o.ytdAct, prev = o.ytdPrev, delta = act - prev;
      return {
        code, nombre: o.nombre, actual: r2(act), anterior: r2(prev), delta: r2(delta),
        pct: prev > 0 ? Math.round(delta / prev * 100) : (act > 0 ? 100 : 0),
        total_periodo: r2(Object.values(o.anios).reduce((s, v) => s + v, 0)),
        por_anio: Object.fromEntries(Object.entries(o.anios).map(([y, v]) => [y, r2(v)]))
      };
    });
    const proveedores = Object.entries(porProvAnio).map(([nombre, a]) => ({ nombre, actual: r2(a.act || 0) }))
      .filter(p => p.actual > 0).sort((a, b) => b.actual - a.actual).slice(0, 10);

    return reply(200, {
      ok: true, empresa: empresa.nombreCorto, anio_actual: anioActual,
      por_anio: Object.entries(porAnio).map(([anio, total]) => ({ anio, total: r2(total) })).sort((a, b) => a.anio.localeCompare(b.anio)),
      tendencia: Object.entries(tendencia).map(([mes, total]) => ({ mes, total: r2(total) })).sort((a, b) => a.mes.localeCompare(b.mes)),
      top_categorias: categorias.filter(c => c.actual > 0).sort((a, b) => b.actual - a.actual).slice(0, 12),
      subieron: categorias.filter(c => c.delta > 0 && c.anterior > 0).sort((a, b) => b.delta - a.delta).slice(0, 6),
      bajaron: categorias.filter(c => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
      top_proveedores: proveedores,
      total_actual: r2(categorias.reduce((s, c) => s + c.actual, 0)),
      total_anterior: r2(categorias.reduce((s, c) => s + c.anterior, 0)),
      _debug: { lineas: rows.length }
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
