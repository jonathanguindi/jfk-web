// netlify/functions/lib/supabase.js
// Cliente Supabase con la SERVICE KEY (solo backend) para registrar envíos de cobranzas
// y leer/actualizar la lista de envío automático.  Devuelve null si no está configurado,
// para que el registro sea "best-effort" y nunca tumbe el envío del correo.

const { createClient } = require('@supabase/supabase-js');

// Acepta los alias de ambas empresas: JFK usa SUPABASE_SERVICE_KEY, Big Dream SUPABASE_SECRET_KEY.
function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';
}

// empresa = getEmpresa() (para la URL por defecto). url/key se pueden forzar por env.
function getSupabase(empresa) {
  const url = process.env.SUPABASE_URL || (empresa && empresa.supabaseUrl);
  const key = getServiceKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = { getSupabase, getServiceKey };
