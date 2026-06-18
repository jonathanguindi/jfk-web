// ventas-sync.js · Job nocturno: sincroniza ventas de SAP a Supabase.
// Programado en netlify.toml (cron). Es reanudable: cada corrida avanza el cursor
// dentro de su presupuesto de tiempo; varias noches completan el histórico inicial.
const { runVentasSync } = require('./lib/ventas-sync-core');

exports.handler = async () => {
  const res = await runVentasSync();
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res) };
};
