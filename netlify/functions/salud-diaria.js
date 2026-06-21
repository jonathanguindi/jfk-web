// netlify/functions/salud-diaria.js
// Chequeo diario de salud del portal. Programado en netlify.toml (cron de la mañana).
// Revisa sync de ventas, RPCs clave, CRM y correo; manda un email de estado al admin.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
let Resend; try { Resend = require('resend').Resend; } catch (e) {}

async function correr() {
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  const checks = [];
  const add = (n, ok, info) => checks.push({ n, ok: !!ok, info: info || '' });

  if (!sb) { add('Conexión Supabase', false, 'getSupabase devolvió null'); return { empresa, checks }; }

  // 1) Sincronización de ventas (frescura)
  try {
    const { data } = await sb.from('ventas_sync_state').select('doc_type,full_done,updated_at,rows_total');
    const times = (data || []).map(r => new Date(r.updated_at || 0).getTime()).filter(Boolean);
    const last = times.length ? Math.max(...times) : 0;
    const horas = last ? (Date.now() - last) / 3600000 : 9999;
    const filas = (data || []).reduce((s, r) => s + (r.rows_total || 0), 0);
    add('Sincronización de ventas', horas < 30, last ? `última hace ${horas.toFixed(1)} h · ${filas.toLocaleString()} filas` : 'sin registro de sync');
  } catch (e) { add('Sincronización de ventas', false, e.message); }

  // 2) RPC del dashboard (ventas_resumen últimos 30 días)
  try {
    const hasta = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await sb.rpc('ventas_resumen', { desde, hasta, p_vendedores: null, p_pais: null });
    add('Dashboard de ventas', !error && !!data, error ? error.message : `ventas 30d: $${Math.round((data && data.kpis && data.kpis.ventas_total) || 0).toLocaleString()}`);
  } catch (e) { add('Dashboard de ventas', false, e.message); }

  // 3) RPC de clientes dormidos
  try {
    const { data, error } = await sb.rpc('ventas_dormidos', { p_dias: 365, p_vendedores: null, p_deuda_max: 50 });
    add('Clientes dormidos', !error, error ? error.message : `${(data || []).length} dormidos (+1 año)`);
  } catch (e) { add('Clientes dormidos', false, e.message); }

  // 4) Detalle de cliente (alimenta el reporte de historial)
  try {
    const { error } = await sb.rpc('ventas_cliente_detalle', { p_card: '___chk___', desde: '2000-01-01', hasta: new Date().toISOString().slice(0, 10), p_vendedores: null });
    add('Reporte de historial (RPC)', !error, error ? error.message : 'responde OK');
  } catch (e) { add('Reporte de historial (RPC)', false, e.message); }

  // 5) CRM Expansión (prospectos)
  try {
    const { count, error } = await sb.from('prospectos').select('*', { count: 'exact', head: true });
    add('CRM Expansión', !error, error ? error.message : `${count || 0} prospectos`);
  } catch (e) { add('CRM Expansión', false, e.message); }

  // 6) Clientes huérfanos: vendedores con ventas recientes (12m) sin correo activo
  try {
    const hasta = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const { data: res } = await sb.rpc('ventas_resumen', { desde, hasta, p_vendedores: null, p_pais: null });
    const pv = ((res && res.por_vendedor) || []).filter(v => v.code != null && (v.total || 0) > 0);
    const { data: cv } = await sb.from('cobranza_vendedores').select('sap_code,email,activo');
    const activos = new Set((cv || []).filter(r => r.activo !== false && (r.email || '').trim()).map(r => r.sap_code));
    const NOISE = /sin\s*agente|trafico|shacalo|mostrador|varios|general|consumidor|^n\/?a$|^\s*-|^\s*$/i;
    const huerf = pv.filter(v => !activos.has(v.code) && !NOISE.test(v.name || '')).sort((a, b) => (b.total || 0) - (a.total || 0));
    const nCli = huerf.reduce((s, v) => s + (v.clientes || 0), 0);
    const det = huerf.slice(0, 4).map(v => `${v.name || 'cód ' + v.code} (${v.clientes || 0} cli)`).join(', ');
    add('Clientes con vendedor activo', nCli === 0, nCli === 0 ? 'OK — todos los vendedores con ventas tienen correo activo' : `⚠️ ${nCli} clientes en ${huerf.length} vendedor(es) SIN correo activo: ${det} — reasignar antes de que se enfríen`);
  } catch (e) { add('Clientes con vendedor activo', false, e.message); }

  // 6.5) Cobertura de costo (para margen)
  try {
    const { count: tot } = await sb.from('ventas_lineas').select('*', { count: 'exact', head: true });
    const { count: conC } = await sb.from('ventas_lineas').select('*', { count: 'exact', head: true }).not('line_cost', 'is', null);
    const pct = tot ? Math.round((conC || 0) / tot * 100) : 0;
    add('Costo para margen', true, `${pct}% de líneas con costo (${(conC || 0).toLocaleString()}/${(tot || 0).toLocaleString()})${pct < 90 ? ' — se llena con el sync' : ''}`);
  } catch (e) { add('Costo para margen', true, 'columna line_cost pendiente: ' + e.message); }

  // 6.6) Vista por año (facturación mensual del año en curso)
  try {
    const y = new Date().getFullYear();
    const { data } = await sb.rpc('ventas_resumen', { desde: y + '-01-01', hasta: new Date().toISOString().slice(0, 10), p_vendedores: null, p_pais: null });
    const t = ((data && data.tendencia) || []).filter(x => (x.mes || '').startsWith(String(y)));
    add('Vista por año', t.length > 0, t.length > 0 ? `${y}: ${t.length} mes(es) con facturación` : 'sin datos del año en curso');
  } catch (e) { add('Vista por año', false, e.message); }

  // 6.7) Panel de CADA vendedor: que su vista scopeada (ventas del año + prospectos) cargue sin error.
  try {
    const { data: cv } = await sb.from('cobranza_vendedores').select('sap_code,email,nombre,activo');
    const byEmail = {};
    (cv || []).forEach(r => {
      if (r.activo === false) return;
      const e = (r.email || '').trim().toLowerCase(); if (!e) return;
      (byEmail[e] = byEmail[e] || { codes: [], nombre: r.nombre || e });
      if (r.sap_code != null) byEmail[e].codes.push(r.sap_code);
    });
    const emails = Object.keys(byEmail);
    const hasta = new Date().toISOString().slice(0, 10);
    const desde = new Date().getFullYear() + '-01-01';
    let okCount = 0; const fails = [];
    for (const e of emails) {
      const v = byEmail[e];
      if (!v.codes.length) { fails.push(`${v.nombre} (sin código SAP → ve $0)`); continue; }
      let ok = true, why = '';
      try { const { error } = await sb.rpc('ventas_resumen', { desde, hasta, p_vendedores: v.codes, p_pais: null }); if (error) { ok = false; why = 'ventas: ' + error.message; } }
      catch (err) { ok = false; why = 'ventas: ' + err.message; }
      if (ok) { try { const { error } = await sb.from('prospectos').select('id', { count: 'exact', head: true }).eq('asignado_email', e); if (error) { ok = false; why = 'prospectos: ' + error.message; } } catch (err) { ok = false; why = 'prospectos: ' + err.message; } }
      if (ok) okCount++; else fails.push(`${v.nombre} (${why})`);
    }
    add('Paneles de vendedores', fails.length === 0, fails.length === 0 ? `${okCount}/${emails.length} vendedores cargan su panel OK` : `${okCount}/${emails.length} OK · revisar: ${fails.slice(0, 5).join('; ')}`);
  } catch (e) { add('Paneles de vendedores', false, e.message); }

  // 7) Correo (Resend)
  add('Correo (Resend)', !!process.env.RESEND_API_KEY, process.env.RESEND_API_KEY ? 'configurado' : 'falta RESEND_API_KEY');

  return { empresa, checks };
}

exports.handler = async () => {
  const { empresa, checks } = await correr();
  const fails = checks.filter(c => !c.ok);
  const ok = fails.length === 0;
  const fecha = new Date().toLocaleString('es-PA', { dateStyle: 'full', timeStyle: 'short' });

  try {
    if (Resend && process.env.RESEND_API_KEY) {
      const r = new Resend(process.env.RESEND_API_KEY);
      const admin = (process.env.VENTAS_ADMIN_EMAIL || (empresa && empresa.admin) || '').trim();
      if (admin) {
        const rows = checks.map(c => `<tr>
          <td style="padding:6px 10px;font-size:16px">${c.ok ? '✅' : '❌'}</td>
          <td style="padding:6px 10px;font-weight:600">${c.n}</td>
          <td style="padding:6px 10px;color:#888;font-size:13px">${c.info}</td></tr>`).join('');
        const banner = ok
          ? `<p style="background:#E6F6EE;color:#1AA06A;padding:12px 14px;border-radius:10px;font-weight:700">✅ Todo está funcionando bien.</p>`
          : `<p style="background:#FDECEC;color:#D8413E;padding:12px 14px;border-radius:10px;font-weight:700">⚠️ Hay ${fails.length} cosa(s) que revisar: ${fails.map(f => f.n).join(', ')}. Avísame y lo arreglamos.</p>`;
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0E1016;max-width:560px">
          <h2 style="margin:0 0 2px">Estado diario · ${(empresa && empresa.nombreCorto) || ''}</h2>
          <p style="color:#888;margin:0 0 14px;font-size:12px">${fecha}</p>
          ${banner}
          <table style="border-collapse:collapse;width:100%;margin-top:8px">${rows}</table>
          <p style="color:#aaa;font-size:11px;margin-top:16px">Chequeo automático del portal. Sincronización de ventas, dashboard, dormidos, reportes, CRM y correo.</p></div>`;
        await r.emails.send({
          from: empresa.from, to: [admin],
          subject: `${ok ? '✅' : '⚠️'} Estado diario · ${(empresa && empresa.nombreCorto) || ''}${ok ? '' : ' · ' + fails.length + ' alerta(s)'}`,
          html
        });
      }
    }
  } catch (e) { /* no romper el chequeo si falla el correo */ }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok, checks }) };
};
