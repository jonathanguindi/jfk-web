// lib/ventas-sync-core.js · baja Facturas y Notas de Crédito de SAP a Supabase.
// Diseño reanudable: procesa por páginas (cursor = DocEntry) dentro de un presupuesto
// de tiempo. Si SAP se tarda, guarda el cursor y la próxima corrida continúa donde quedó.
// El cron nocturno lo va completando; el botón "Sincronizar ahora" lo empuja a mano.

const { getEmpresa } = require('./empresa-config');
const { getSupabase } = require('./supabase');
const { sapLogin, sapLogout, cargarMapas, paginaDocumentos } = require('./sap-ventas');

const PAGE_SIZE      = 20;     // documentos por página (cada uno trae sus líneas)
const TIME_BUDGET_MS = 22000;  // no iniciar otra página pasado esto
const RECURSOS = [
  { recurso: 'Invoices',    docType: 'I', signo:  1 },
  { recurso: 'CreditNotes', docType: 'C', signo: -1 },
];

// Convierte un documento SAP + mapas en filas de ventas_lineas.
function documentoAFilas(doc, docType, signo, mapas) {
  const fecha = (doc.DocDate || '').slice(0, 10);
  const spCode = doc.SalesPersonCode;
  const countryCode = mapas.clientePais.get(doc.CardCode) || null;
  const filas = [];
  let lineNum = 0;
  for (const l of (doc.DocumentLines || [])) {
    const groupCode = mapas.itemGrupo.get(l.ItemCode);
    filas.push({
      line_uid: `${docType}|${doc.DocEntry}|${lineNum}`,
      doc_type: docType,
      doc_entry: doc.DocEntry,
      doc_num: doc.DocNum || null,
      doc_date: fecha,
      card_code: doc.CardCode,
      card_name: doc.CardName || null,
      country_code: countryCode,
      country_name: countryCode ? (mapas.paisNombre.get(countryCode) || countryCode) : null,
      sales_person_code: (spCode != null && spCode > 0) ? spCode : null,
      sales_person_name: (spCode != null && spCode > 0) ? (mapas.vendedor.get(spCode) || null) : null,
      item_code: l.ItemCode || null,
      item_description: l.ItemDescription || null,
      item_group_code: groupCode != null ? groupCode : null,
      item_group_name: groupCode != null ? (mapas.grupoNombre.get(groupCode) || null) : null,
      quantity: Number(l.Quantity) || 0,
      line_total: (Number(l.LineTotal) || 0) * signo,
    });
    lineNum++;
  }
  return filas;
}

async function runVentasSync(opts = {}) {
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return { ok: false, error: 'Supabase no configurado (falta SUPABASE_SERVICE_KEY)' };

  // reset=true reinicia los cursores (re-baja todo desde 0).
  if (opts.reset) {
    await sb.from('ventas_sync_state').update({ last_doc_entry: 0, full_done: false }).neq('doc_type', '');
  }

  const t0 = Date.now();
  let cookie;
  const resumen = { ok: true, procesado: {}, filas: 0, completo: true };
  try {
    cookie = await sapLogin();
    const mapas = await cargarMapas(cookie);

    // Refrescar fichas de cliente (contacto) en lotes — best-effort, no tumba el sync.
    try {
      const filas = (mapas.clientes || []).filter(c => c.card_code);
      for (let i = 0; i < filas.length; i += 500) {
        await sb.from('ventas_clientes').upsert(filas.slice(i, i + 500), { onConflict: 'card_code' });
      }
      resumen.clientes = filas.length;
    } catch (e) { resumen.clientes_error = e.message; }

    for (const { recurso, docType, signo } of RECURSOS) {
      const { data: stRows } = await sb.from('ventas_sync_state').select('*').eq('doc_type', docType).limit(1);
      const st = (stRows && stRows[0]) || { last_doc_entry: 0, rows_total: 0, full_done: false };
      let cursor = st.last_doc_entry || 0;
      let rowsTotal = st.rows_total || 0;
      let procesadosDocs = 0, fin = false;

      while (Date.now() - t0 < TIME_BUDGET_MS) {
        let page;
        try {
          page = await paginaDocumentos(cookie, recurso, cursor, PAGE_SIZE);
        } catch (e) {
          if (e && e.name === 'AbortError') { resumen.completo = false; break; }
          throw e;
        }
        if (!page.docs.length) { fin = true; break; }

        const filas = page.docs.flatMap(d => documentoAFilas(d, docType, signo, mapas));
        if (filas.length) {
          const { error } = await sb.from('ventas_lineas').upsert(filas, { onConflict: 'line_uid' });
          if (error) throw new Error(`upsert ${recurso}: ${error.message}`);
          rowsTotal += filas.length;
          resumen.filas += filas.length;
        }
        cursor = page.nextCursor;
        procesadosDocs += page.docs.length;

        await sb.from('ventas_sync_state').update({
          last_doc_entry: cursor, rows_total: rowsTotal, updated_at: new Date().toISOString()
        }).eq('doc_type', docType);

        if (page.fin) { fin = true; break; }
      }

      if (fin) {
        await sb.from('ventas_sync_state').update({ full_done: true, updated_at: new Date().toISOString() }).eq('doc_type', docType);
      } else {
        resumen.completo = false;
      }
      resumen.procesado[recurso] = { docs: procesadosDocs, cursor, fin };
    }

    await sapLogout(cookie); cookie = null;
    return resumen;
  } catch (e) {
    if (cookie) await sapLogout(cookie);
    return { ok: false, error: e.message || String(e), parcial: resumen };
  }
}

module.exports = { runVentasSync };
