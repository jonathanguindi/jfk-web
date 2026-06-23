// sap-explorar.js · Sonda LIGERA de SOLO LECTURA (una página por recurso) para ver qué expone SAP.
// Diagnóstico, SOLO ADMIN. No escribe nada.
const { getEmpresa } = require('./lib/empresa-config');
const { SAP_URL, sapLogin } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

async function getOne(cookie, path, timeoutMs = 7000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${SAP_URL}/${path}`, {
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Prefer: 'odata.maxpagesize=3' },
      signal: ac.signal
    });
    if (!r.ok) return { error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const j = await r.json();
    return { value: j.value || [] };
  } catch (e) { return { error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();
    const recurso = body.recurso || null;   // permite probar uno específico
    const out = { ok: true, empresa: empresa.nombreCorto };

    if (!recurso || recurso === 'empleados') {
      const e = await getOne(cookie, 'EmployeesInfo?$top=3');
      out.empleados = e.error ? { error: e.error } : { count_muestra: e.value.length, campos: e.value[0] ? Object.keys(e.value[0]) : [], ejemplo: e.value[0] || null };
    }
    if (!recurso || recurso === 'cuentas') {
      const a = await getOne(cookie, 'ChartOfAccounts?$top=3&$select=Code,Name,AccountType,ActiveAccount,Balance');
      out.cuentas = a.error ? { error: a.error } : { muestra: a.value, campos: a.value[0] ? Object.keys(a.value[0]) : [] };
    }
    if (recurso === 'gastos') {
      const a = await getOne(cookie, "ChartOfAccounts?$filter=AccountType eq 'at_Expenses'&$top=20&$select=Code,Name,Balance,ActiveAccount", 9000);
      out.gastos = a.error ? { error: a.error } : { cuentas: a.value, con_saldo: a.value.filter(x => Number(x.Balance) !== 0).length };
    }
    if (recurso === 'cuentas_gasto') {
      const a = await getOne(cookie, "ChartOfAccounts?$filter=startswith(Code,'610')&$top=60&$select=Code,Name,ActiveAccount", 9000);
      out.cuentas_gasto = a.error ? { error: a.error } : (a.value || []).map(x => ({ code: x.Code, name: x.Name, activa: x.ActiveAccount }));
    }
    if (recurso === 'asientos') {
      const a = await getOne(cookie, 'JournalEntries?$orderby=JdtNum desc&$top=3', 9000);
      if (a.error) out.asientos = { error: a.error };
      else out.asientos = (a.value || []).map(j => ({
        num: j.JdtNum, fecha: (j.ReferenceDate || '').slice(0, 10), memo: j.Memo,
        lineas: (j.JournalEntryLines || []).slice(0, 6).map(l => ({ cuenta: l.AccountCode, debe: l.Debit, haber: l.Credit, detalle: l.LineMemo }))
      }));
    }
    if (recurso === 'compras_servicio') {
      const a = await getOne(cookie, "PurchaseInvoices?$filter=DocType eq 'dDocument_Service'&$orderby=DocEntry desc&$top=3&$select=DocEntry,DocNum,CardName,DocDate,DocTotal,DocumentLines", 9000);
      if (a.error) out.compras_servicio = { error: a.error };
      else out.compras_servicio = (a.value || []).map(d => ({
        doc: d.DocNum, proveedor: d.CardName, fecha: (d.DocDate || '').slice(0, 10), total: d.DocTotal,
        lineas: (d.DocumentLines || []).slice(0, 5).map(l => ({ cuenta: l.AccountCode, desc: l.ItemDescription || l.FreeText, monto: l.LineTotal }))
      }));
    }
    if (recurso === 'journal') {
      const j = await getOne(cookie, 'JournalEntries?$top=1');
      out.journal = j.error ? { error: j.error } : { campos: j.value[0] ? Object.keys(j.value[0]) : [], ejemplo: j.value[0] || null };
    }
    return reply(200, out);
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
