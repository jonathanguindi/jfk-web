// netlify/functions/lib/empresa-config.js
// Configuración por empresa (branding, correos e instrucciones bancarias).
// Se selecciona automáticamente según SAP_COMPANY_DB:
//   JFK        -> LAMPA2007
//   Big Dream  -> SBO_BIDRBRASA
// También se puede forzar con la variable de entorno COBRANZA_EMPRESA = 'JFK' | 'BDB'.
//
// ⚠️ COMPLETAR LAS INSTRUCCIONES BANCARIAS (marcadas con TODO) antes de usar en producción.
//    Se pueden dejar en este archivo o sobreescribir con variables de entorno (ver más abajo).

const EMPRESAS = {
  JFK: {
    id: 'JFK',
    nombreLegal: 'JFK INTERNATIONAL, S.A.',
    nombreCorto: 'JFK International',
    subtitulo: 'RUC 304748-1-410636 DV 71  ·  Zona Libre de Colón, Panamá  ·  Tel: 441-5267',
    supabaseUrl: 'https://gpighopguwafnxouejfb.supabase.co',
    // Color de acento (naranja JFK) usado en el PDF — mismo de la web.
    accent: [255, 107, 53],
    // Remitente del correo. El buzón debe existir en el dominio verificado en Resend.
    from: 'JFK International | Accounts <accounts@jfkintl.com>',
    // Copia (CC) a cobros para llevar el control. Override: env COBRANZA_CC
    cc: 'cobranzas@jfkintl.com',
    // Correo del administrador que recibe el resumen diario para aprobar. Override: env COBRANZA_ADMIN
    admin: 'jonathang@jfkintl.com',
    // Instrucciones bancarias (Banistmo) — se incluyen en el PDF y el correo.
    banco: [
      { label: 'Beneficiario',        value: 'JFK INTERNATIONAL, S.A.' },
      { label: 'Cuenta',              value: '0111263647' },
      { label: 'Dirección',           value: 'Calle 14 Ave. Sta. Isabel, Edificio Lamparama, frente a Regal Intl.' },
      { label: 'Banco',               value: 'BANISTMO, S.A.  ·  SWIFT MIDLPAPA  ·  Torre Banistmo, Calle 50' },
      { label: 'Banco intermediario', value: 'CITIBANK, N.A.  ·  SWIFT CITIUS33XXX  ·  111 Wall St., New York, NY 10043, USA' },
      { label: 'Referencia',          value: 'Indique el código de cliente en el detalle del pago.' }
    ]
  },
  BDB: {
    id: 'BDB',
    nombreLegal: 'BIG DREAM, S.A.',
    nombreCorto: 'Big Dream',
    subtitulo: 'TODO — RUC / dirección / teléfono de Big Dream',
    supabaseUrl: 'https://birbtcnifhnviohkgyec.supabase.co',
    accent: [20, 110, 200],
    from: 'Big Dream | Accounts <accounts@TODO-dominio-bigdream.com>',
    cc: 'cobranzas@TODO-dominio-bigdream.com',
    admin: 'jonathang@jfkintl.com',
    banco: [
      { label: 'Beneficiario', value: 'BIG DREAM, S.A.' },
      { label: 'Banco',        value: 'TODO — nombre del banco' },
      { label: 'Cuenta',       value: 'TODO — número de cuenta' },
      { label: 'Tipo',         value: 'TODO — corriente / ahorros' },
      { label: 'SWIFT / ABA',  value: 'TODO — código' },
      { label: 'Referencia',   value: 'Indique el código de cliente en el detalle del pago.' }
    ]
  }
};

function getEmpresa() {
  const forced = (process.env.COBRANZA_EMPRESA || '').toUpperCase();
  let cfg;
  if (forced && EMPRESAS[forced]) cfg = EMPRESAS[forced];
  else {
    const db = process.env.SAP_COMPANY_DB || '';
    cfg = /BIDRBRASA|BIG.?DREAM/i.test(db) ? EMPRESAS.BDB : EMPRESAS.JFK;
  }
  // Permitir overrides puntuales por variable de entorno (sin tocar código).
  return {
    ...cfg,
    from: process.env.COBRANZA_FROM || cfg.from,
    cc: process.env.COBRANZA_CC || cfg.cc,
    admin: process.env.COBRANZA_ADMIN || cfg.admin,
    supabaseUrl: process.env.SUPABASE_URL || cfg.supabaseUrl
  };
}

module.exports = { getEmpresa, EMPRESAS };
