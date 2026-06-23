// gastos-analisis.js · Analiza los GASTOS reales de SAP (facturas de servicio a proveedores) por
// cuenta, mes y año. SOLO LECTURA, SOLO ADMIN. Devuelve totales por año, por categoría, tendencia,
// y comparativo año vs año (qué subió/bajó) para el dashboard de gastos.
const { getEmpresa } = require('./lib/empresa-config');
const { SAP_URL, sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const prefijo = process.env.SAP_GASTO_PREFIX || '61';      // 61 JFK · 7 BDB
    const itbmsAcct = process.env.SAP_ITBMS_ACCT || '610224';  // se excluye del análisis
    const anios = Math.min(6, Math.max(2, Number(body.anios) || 4));
    const hoy = new Date();
    const anioActual = hoy.getUTCFullYear();
    const desde = (anioActual - anios + 1) + '-01-01';

    const cookie = await sapLogin();

    // Nombres de cuentas de gasto
    const cuentasRows = await sapGetAll(cookie, `ChartOfAccounts?$filter=startswith(Code,'${prefijo}')&$select=Code,Name`);
    const nombreCuenta = new Map((cuentasRows || []).map(c => [c.Code, c.Name]));

    // Facturas de servicio (gastos) desde 'desde'. Paginado con tope de seguridad.
    const path = `PurchaseInvoices?$filter=DocType eq 'dDocument_Service' and DocDate ge '${desde}'&$select=DocDate,DocumentLines&$orderby=DocEntry desc`;
    const docs = await sapGetAll(cookie, path);

    const porAnio = {};                  // anio -> total
    const porCuentaAnio = {};            // code -> { anio -> total }
    const tendencia = {};                // 'YYYY-MM' -> total (solo para gráfica)
    let totalLineas = 0;

    for (const d of (docs || [])) {
      const fecha = (d.DocDate || '').slice(0, 10);
      if (!fecha) continue;
      const anio = fecha.slice(0, 4);
      const ym = fecha.slice(0, 7);
      for (const l of (d.DocumentLines || [])) {
        const code = l.AccountCode;
        if (!code || !String(code).startsWith(prefijo)) continue;   // solo cuentas de gasto
        if (code === itbmsAcct) continue;                            // ITBMS no es gasto
        const monto = Number(l.LineTotal) || 0;
        if (!monto) continue;
        totalLineas++;
        porAnio[anio] = (porAnio[anio] || 0) + monto;
        (porCuentaAnio[code] || (porCuentaAnio[code] = {}))[anio] = (porCuentaAnio[code][anio] || 0) + monto;
        tendencia[ym] = (tendencia[ym] || 0) + monto;
      }
    }

    const anioPrev = String(anioActual - 1), anioAct = String(anioActual);
    // Por categoría con comparativo año actual vs anterior
    const categorias = Object.entries(porCuentaAnio).map(([code, porA]) => {
      const act = porA[anioAct] || 0, prev = porA[anioPrev] || 0;
      const delta = act - prev;
      const pct = prev > 0 ? Math.round((delta / prev) * 100) : (act > 0 ? 100 : 0);
      return {
        code, nombre: nombreCuenta.get(code) || code,
        actual: r2(act), anterior: r2(prev), delta: r2(delta), pct,
        total_periodo: r2(Object.values(porA).reduce((s, v) => s + v, 0)),
        por_anio: Object.fromEntries(Object.entries(porA).map(([y, v]) => [y, r2(v)]))
      };
    });

    const totActual = categorias.reduce((s, c) => s + c.actual, 0);
    const totPrev = categorias.reduce((s, c) => s + c.anterior, 0);
    // Alertas: las que más subieron (en $) respecto al año pasado
    const subieron = categorias.filter(c => c.delta > 0 && c.anterior > 0).sort((a, b) => b.delta - a.delta).slice(0, 6);
    const bajaron = categorias.filter(c => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);
    const topActual = categorias.filter(c => c.actual > 0).sort((a, b) => b.actual - a.actual).slice(0, 12);

    return reply(200, {
      ok: true,
      empresa: empresa.nombreCorto,
      anio_actual: anioActual,
      por_anio: Object.entries(porAnio).map(([anio, total]) => ({ anio, total: r2(total) })).sort((a, b) => a.anio.localeCompare(b.anio)),
      tendencia: Object.entries(tendencia).map(([mes, total]) => ({ mes, total: r2(total) })).sort((a, b) => a.mes.localeCompare(b.mes)),
      top_categorias: topActual,
      subieron, bajaron,
      total_actual: r2(totActual), total_anterior: r2(totPrev),
      _debug: { facturas: (docs || []).length, lineas: totalLineas, desde, cuentas: nombreCuenta.size }
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
