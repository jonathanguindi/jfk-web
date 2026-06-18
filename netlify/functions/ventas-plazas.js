// ventas-plazas.js · Organización de vendedores por plaza (país).
//  POST { action:'list', desde, hasta }       -> países con ventas, desglose por vendedor,
//                                                propuesta (líder por datos) y asignación actual.
//  POST { action:'asignar', country_code, country_name, sales_person_code, sales_person_name }
//  POST { action:'limpiar', country_code }     -> quita la asignación de un país.
//  POST { action:'aplicar_propuesta', desde, hasta }  -> asigna a cada país su líder por datos.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

function rango(body) {
  const hoy = new Date();
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(body.hasta || '') ? body.hasta : hoy.toISOString().slice(0, 10);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(body.desde || '') ? body.desde
    : new Date(hoy.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  return { desde, hasta };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });

    // Solo el administrador gestiona plazas.
    const email = (body.email || '').trim().toLowerCase();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if (!adminEmail || email !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const action = body.action || 'list';

    if (action === 'asignar') {
      if (!body.country_code) return reply(400, { ok: false, error: 'Falta country_code' });
      const { error } = await sb.from('ventas_plaza_pais').upsert({
        country_code: body.country_code,
        country_name: body.country_name || null,
        sales_person_code: body.sales_person_code != null ? Number(body.sales_person_code) : null,
        sales_person_name: body.sales_person_name || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'country_code' });
      if (error) return reply(500, { ok: false, error: error.message });
      return reply(200, { ok: true });
    }

    if (action === 'limpiar') {
      const { error } = await sb.from('ventas_plaza_pais').delete().eq('country_code', body.country_code);
      if (error) return reply(500, { ok: false, error: error.message });
      return reply(200, { ok: true });
    }

    // list / aplicar_propuesta comparten el cálculo
    const { desde, hasta } = rango(body);
    const { data: plazas, error } = await sb.rpc('ventas_plazas', { desde, hasta });
    if (error) return reply(500, { ok: false, error: error.message });

    if (action === 'aplicar_propuesta') {
      const filas = (plazas || []).map(p => {
        const lider = (p.vendedores || []).find(v => v.code != null);
        if (!lider) return null;
        return { country_code: p.code, country_name: p.name, sales_person_code: lider.code, sales_person_name: lider.name, updated_at: new Date().toISOString() };
      }).filter(Boolean);
      if (filas.length) {
        const { error: e2 } = await sb.from('ventas_plaza_pais').upsert(filas, { onConflict: 'country_code' });
        if (e2) return reply(500, { ok: false, error: e2.message });
      }
      return reply(200, { ok: true, asignados: filas.length });
    }

    return reply(200, { ok: true, plazas: plazas || [], periodo: { desde, hasta } });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
