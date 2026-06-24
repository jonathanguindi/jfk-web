// customers-sync-background.js
// Sincroniza TODOS los clientes (BusinessPartners tipo Customer) de SAP -> tabla `customers` de Supabase.
// Background (hasta 15 min). Protegido por token. Idempotente (upsert por sap_card_code):
// solo actualiza columnas que vienen de SAP; NO toca el PIN ni otras columnas del portal de clientes.
// Disparo: POST /.netlify/functions/customers-sync-background  body {"token":"..."}
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { sapLogin, sapLogout, sapGetAll } = require('./lib/sap-ventas');

exports.handler = async (event) => {
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const token = body.token || (event.queryStringParameters && event.queryStringParameters.token) || '';
  const expected = process.env.VENTAS_SYNC_TOKEN;
  const esProgramado = !!body.next_run;   // las corridas programadas de Netlify traen next_run
  if (expected && token !== expected && !esProgramado) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'token inválido' }) };
  }

  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Supabase no configurado' }) };

  let cookie;
  try {
    cookie = await sapLogin();
    const sel = 'CardCode,CardName,FederalTaxID,EmailAddress,Phone1,Cellular,City,CurrentAccountBalance,PriceListNum,Valid,CardType';
    // Solo clientes. Si el filtro falla en este SAP, baja todos y filtra en memoria.
    let raw = await sapGetAll(cookie, `BusinessPartners?$select=${sel}&$filter=CardType eq 'cCustomer'`)
      .catch(() => sapGetAll(cookie, `BusinessPartners?$select=${sel}`).catch(() => []));
    await sapLogout(cookie); cookie = null;

    const rows = (raw || [])
      .filter(b => b && b.CardCode && (b.CardType == null || b.CardType === 'cCustomer'))
      .map(b => ({
        sap_card_code: b.CardCode,
        name: b.CardName || b.CardCode,
        tax_id: b.FederalTaxID || null,
        email: b.EmailAddress ? String(b.EmailAddress).trim().toLowerCase() : null,
        phone: b.Phone1 || null,
        mobile: b.Cellular || null,
        city: b.City || null,
        current_balance: Number(b.CurrentAccountBalance) || 0,
        sap_price_list_num: (b.PriceListNum != null) ? Number(b.PriceListNum) : null,
        active: b.Valid === 'tNO' ? false : true
      }));

    let upserted = 0, conCorreo = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('customers').upsert(chunk, { onConflict: 'sap_card_code' });
      if (error) return { statusCode: 200, body: JSON.stringify({ ok: false, error: error.message, upserted }) };
      upserted += chunk.length;
      conCorreo += chunk.filter(c => c.email).length;
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, total: rows.length, upserted, conCorreo }) };
  } catch (e) {
    if (cookie) { try { await sapLogout(cookie); } catch (_) {} }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
