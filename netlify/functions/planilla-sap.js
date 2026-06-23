// planilla-sap.js · Lee la PLANILLA/empleados directo de SAP (EmployeesInfo). SOLO LECTURA, SOLO ADMIN.
const { getEmpresa } = require('./lib/empresa-config');
const { sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Convierte el salario a base MENSUAL según la unidad de SAP.
function aMensual(salary, unit) {
  const s = Number(salary) || 0;
  switch (unit) {
    case 'scu_Year': return s / 12;
    case 'scu_Week': return s * 52 / 12;
    case 'scu_Day': return s * 30;
    case 'scu_Hour': return s * 173.33;
    case 'scu_Month': default: return s;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();
    const rows = await sapGetAll(cookie, 'EmployeesInfo?$select=EmployeeID,FirstName,LastName,JobTitle,Department,Salary,SalaryUnit,StartDate,StatusCode,TerminationDate,IdNumber,eMail');

    const hoy = new Date();
    const empleados = rows.map(e => {
      const activo = !e.TerminationDate;
      const ingreso = e.StartDate ? e.StartDate.slice(0, 10) : null;
      const antiguedad = ingreso ? Math.floor((hoy - new Date(ingreso + 'T00:00:00')) / (365.25 * 86400000)) : null;
      const mensual = aMensual(e.Salary, e.SalaryUnit);
      return {
        id: e.EmployeeID,
        nombre: [e.FirstName, e.LastName].filter(Boolean).join(' ').trim(),
        cargo: e.JobTitle || '',
        depto: e.Department != null ? e.Department : '',
        salario: r2(Number(e.Salary) || 0),
        unidad: e.SalaryUnit || '',
        salario_mensual: r2(mensual),
        fecha_ingreso: ingreso,
        antiguedad_anos: antiguedad,
        cedula: e.IdNumber || '',
        email: e.eMail || '',
        activo
      };
    });

    const activos = empleados.filter(e => e.activo);
    const totalMensual = activos.reduce((s, e) => s + e.salario_mensual, 0);
    empleados.sort((a, b) => b.salario_mensual - a.salario_mensual);

    return reply(200, {
      ok: true,
      empresa: empresa.nombreCorto,
      total_empleados: empleados.length,
      activos: activos.length,
      planilla_mensual: r2(totalMensual),
      planilla_anual: r2(totalMensual * 12),
      empleados
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
