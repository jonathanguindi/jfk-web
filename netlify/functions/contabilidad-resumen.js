// contabilidad-resumen.js · Panel de contabilidad (SOLO ADMIN).
// Devuelve P&L (ventas, costo, utilidad bruta, margen %) reutilizando el RPC ventas_resumen,
// y Cuentas por Cobrar (cartera) desde la tabla customers (current_balance sincronizado de SAP).
// Los COSTOS/MÁRGENES solo se calculan y devuelven si el correo es el admin de la empresa.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Rango de fechas según periodo: 'mes' (actual), 'mes_pasado', 'ano' (año en curso). Default: mes.
function rango(periodo) {
  const hoy = new Date();
  const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (periodo === 'ano') return { desde: `${y}-01-01`, hasta: iso(hoy) };
  if (periodo === 'mes_pasado') {
    const d1 = new Date(Date.UTC(y, m - 1, 1)), d2 = new Date(Date.UTC(y, m, 0));
    return { desde: iso(d1), hasta: iso(d2) };
  }
  return { desde: iso(new Date(Date.UTC(y, m, 1))), hasta: iso(hoy) };   // mes actual
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });

    // GATING: solo el admin ve costos/márgenes/contabilidad.
    const email = (body.email || '').trim().toLowerCase();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if (!adminEmail || email !== adminEmail) {
      return reply(403, { ok: false, error: 'Solo el administrador puede ver la contabilidad' });
    }

    const periodo = body.periodo || 'mes';
    const { desde, hasta } = rango(periodo);

    // 1) P&L del periodo (ventas, costo, margen, tendencia, por categoría, top clientes) — admin = todos.
    const pnlP = sb.rpc('ventas_resumen', { desde, hasta, p_vendedores: null, p_pais: null });

    // 2) Cuentas por cobrar: clientes con saldo > 0 (snapshot diario de SAP).
    const arP = (async () => {
      let rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('customers')
          .select('sap_card_code,name,current_balance,city')
          .gt('current_balance', 0)
          .order('current_balance', { ascending: false })
          .range(from, from + 999);
        if (error) throw new Error(error.message);
        if (!data || !data.length) break;
        rows = rows.concat(data);
        if (data.length < 1000) break;
      }
      const total = rows.reduce((s, c) => s + (Number(c.current_balance) || 0), 0);
      return {
        total: r2(total),
        num_deudores: rows.length,
        top: rows.slice(0, 30).map(c => ({
          sap_card_code: c.sap_card_code, name: c.name || c.sap_card_code,
          saldo: r2(c.current_balance), city: c.city || ''
        }))
      };
    })();

    const [{ data: pnl, error: pnlErr }, ar] = await Promise.all([pnlP, arP]);
    if (pnlErr) return reply(500, { ok: false, error: 'P&L: ' + pnlErr.message });

    return reply(200, {
      ok: true,
      periodo, desde, hasta,
      empresa: empresa.nombreCorto,
      pnl: pnl || {},
      cuentas_por_cobrar: ar,
      cuentas_por_pagar: { disponible: false, nota: 'Pendiente: sincronizar facturas de proveedores de SAP.' }
    });
  } catch (e) {
    return reply(500, { ok: false, error: e.message || String(e) });
  }
};
