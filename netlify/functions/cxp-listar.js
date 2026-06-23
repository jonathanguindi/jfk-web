// cxp-listar.js · Lista las facturas por pagar guardadas en cxp_revision, con filtro. SOLO ADMIN.
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

    const filtro = body.filtro || 'vencido';  // vencido | pendiente | cerrar | activa | vigente | todo

    // Traer todo (paginado) y filtrar/contar en JS para devolver también los totales por estado.
    let rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('cxp_revision')
        .select('doc_entry,doc_num,card_code,proveedor,fecha,vence,saldo,atraso,anio,vigente,moneda,decision,nota')
        .order('atraso', { ascending: false })
        .range(from, from + 999);
      if (error) return reply(200, { ok: false, error: error.message });
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
    }

    const resumen = {
      total: rows.length,
      saldo_total: r2(rows.reduce((s, r) => s + (Number(r.saldo) || 0), 0)),
      vencidas: rows.filter(r => r.atraso > 0).length,
      saldo_vencido: r2(rows.filter(r => r.atraso > 0).reduce((s, r) => s + (Number(r.saldo) || 0), 0)),
      pendientes: rows.filter(r => !r.decision).length,
      marcadas_cerrar: rows.filter(r => r.decision === 'cerrar').length,
      saldo_cerrar: r2(rows.filter(r => r.decision === 'cerrar').reduce((s, r) => s + (Number(r.saldo) || 0), 0)),
      marcadas_activa: rows.filter(r => r.decision === 'activa').length
    };

    let lista = rows;
    if (filtro === 'vencido') lista = rows.filter(r => r.atraso > 0);
    else if (filtro === 'pendiente') lista = rows.filter(r => !r.decision);
    else if (filtro === 'cerrar') lista = rows.filter(r => r.decision === 'cerrar');
    else if (filtro === 'activa') lista = rows.filter(r => r.decision === 'activa');
    else if (filtro === 'vigente') lista = rows.filter(r => r.vigente);
    // 'todo' = sin filtro

    return reply(200, { ok: true, empresa: empresa.nombreCorto, filtro, resumen, facturas: lista });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
