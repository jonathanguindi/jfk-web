// sap-explorar.js · Sonda LIGERA de SOLO LECTURA (una página por recurso) para ver qué expone SAP.
// Diagnóstico, SOLO ADMIN. No escribe nada.
const { getEmpresa } = require('./lib/empresa-config');
const { SAP_URL, sapLogin, sapGetAll } = require('./lib/sap-ventas');

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
    if (recurso === 'empleados_full') {
      const e = await sapGetAll(cookie, 'EmployeesInfo?$select=EmployeeID,FirstName,LastName,JobTitle,Department,Salary,SalaryUnit,StartDate,StatusCode,TerminationDate,Active');
      out.empleados_full = { total: (e || []).length, lista: (e || []).map(x => ({ id: x.EmployeeID, nombre: [x.FirstName, x.LastName].filter(Boolean).join(' '), cargo: x.JobTitle, salario: x.Salary, unidad: x.SalaryUnit, ingreso: (x.StartDate || '').slice(0, 10), term: x.TerminationDate, activo: x.Active })) };
    }
    if (recurso === 'cuentas_buscar') {
      const q = (body.q || '').replace(/'/g, "''");
      const a = await sapGetAll(cookie, `ChartOfAccounts?$filter=contains(Name,'${q}')&$select=Code,Name,Balance,ActiveAccount`);
      out.cuentas_buscar = { q, cuentas: (a || []).map(c => ({ code: c.Code, name: c.Name, balance: c.Balance, activa: c.ActiveAccount })) };
    }
    if (recurso === 'item') {
      // Stock real en SAP de un código (o prefijo): total OnHand + por bodega.
      const code = (body.q || '').replace(/'/g, "''");
      const filtro = code.length >= 8 ? `ItemCode eq '${code}'` : `startswith(ItemCode,'${code}')`;
      const a = await getOne(cookie, `Items?$filter=${filtro}&$top=40&$select=ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,Valid,Frozen,ItemWarehouseInfoCollection`, 9000);
      if (a.error) out.item = { error: a.error };
      else out.item = (a.value || []).map(it => ({
        code: it.ItemCode, name: it.ItemName, onHand: it.QuantityOnStock,
        comprometido: it.QuantityOrderedByCustomers, pedidoAProv: it.QuantityOrderedFromVendors,
        valido: it.Valid, congelado: it.Frozen,
        bodegas: (it.ItemWarehouseInfoCollection || []).filter(w => Number(w.InStock) !== 0 || Number(w.Committed) !== 0).map(w => ({ bod: w.WarehouseCode, enStock: w.InStock, comprometido: w.Committed }))
      }));
    }
    if (recurso === 'pedido_dump') {
      // Vuelca TODOS los campos escalares + U_ de un pedido por DocNum (para diff manual).
      const dn = Number(body.doc_num);
      const a = await getOne(cookie, `Orders?$filter=DocNum eq ${dn}&$top=1`, 9000);
      const o = (a.value && a.value[0]) || null;
      if (!o) { out.pedido_dump = { error: a.error || 'no encontrado', doc_num: dn }; }
      else {
        const flat = {};
        for (const k of Object.keys(o)) { if (o[k] !== null && typeof o[k] !== 'object') flat[k] = o[k]; }
        out.pedido_dump = { doc_num: o.DocNum, doc_entry: o.DocEntry, status: o.DocumentStatus, campos: flat };
      }
    }
    if (recurso === 'aprob_diff') {
      // Compara un pedido AUTORIZADO vs uno NO autorizado: qué campos difieren (para saber cómo se autoriza).
      const aut = await getOne(cookie, "Orders?$filter=NTSApproved eq 'tYES' and DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc&$top=1", 9000);
      const noaut = await getOne(cookie, "Orders?$filter=NTSApproved eq 'tNO' and DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc&$top=1", 9000);
      const A = (aut.value && aut.value[0]) || null, B = (noaut.value && noaut.value[0]) || null;
      if (!A || !B) { out.aprob_diff = { error: 'falta muestra', hay_aut: !!A, hay_noaut: !!B, errA: aut.error, errB: noaut.error }; }
      else {
        const skip = new Set(['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocTotal', 'DocumentLines', 'NumAtCard', 'TaxDate', 'CreationDate', 'UpdateDate', 'DocTime', 'Comments', 'DocTotalFc', 'DocTotalSys', 'VatSum', 'VatSumFc', 'VatSumSys', 'DocObjectCode', 'DocCurrency', 'DocRate']);
        const dif = [];
        for (const k of Object.keys(A)) {
          if (skip.has(k)) continue;
          const va = A[k], vb = B[k];
          if (typeof va === 'object') continue;
          if (va !== vb) dif.push({ campo: k, autorizado: va, no_autorizado: vb });
        }
        out.aprob_diff = { doc_aut: A.DocNum, doc_noaut: B.DocNum, NTSApprovedNumber_aut: A.NTSApprovedNumber, diferencias: dif };
      }
    }
    if (recurso === 'pedidos_abiertos') {
      const a = await getOne(cookie, "Orders?$filter=DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc&$top=8&$select=DocNum,DocEntry,CardCode,CardName,DocTotal,DocumentStatus,Cancelled,NTSApproved,AuthorizationStatus,NTSApprovedNumber,DocDate", 9000);
      out.pedidos_abiertos = a.error ? { error: a.error } : (a.value || []);
    }
    if (recurso === 'pedido') {
      // Un pedido reciente completo, para ver campos de autorización y de costo/margen.
      const a = await getOne(cookie, 'Orders?$orderby=DocEntry desc&$top=1', 9000);
      const o = (a.value && a.value[0]) || null;
      if (!o) { out.pedido = { error: a.error || 'sin pedidos' }; }
      else {
        const ln = (o.DocumentLines && o.DocumentLines[0]) || {};
        out.pedido = {
          campos_doc: Object.keys(o),
          udf: Object.fromEntries(Object.keys(o).filter(k => k.startsWith('U_')).map(k => [k, o[k]])),
          DocEntry: o.DocEntry, DocNum: o.DocNum, DocumentStatus: o.DocumentStatus, Cancelled: o.Cancelled,
          campos_linea: Object.keys(ln),
          linea_costo: { ItemCode: ln.ItemCode, Quantity: ln.Quantity, UnitPrice: ln.UnitPrice, Price: ln.Price, LineTotal: ln.LineTotal, StockPrice: ln.StockPrice, GrossProfit: ln.GrossProfit, GrossBuyPrice: ln.GrossBuyPrice }
        };
      }
    }
    if (recurso === 'proveedores') {
      const a = await getOne(cookie, "BusinessPartners?$filter=CardType eq 'cSupplier'&$orderby=CardCode desc&$top=6&$select=CardCode,CardName,FederalTaxID,Phone1,EmailAddress,Currency,Series,GroupCode", 9000);
      out.proveedores = a.error ? { error: a.error } : (a.value || []);
    }
    if (recurso === 'series') {
      const a = await getOne(cookie, "SeriesService_GetDocumentSeries", 9000);
      out.series = a.error ? { error: a.error } : a.value;
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
