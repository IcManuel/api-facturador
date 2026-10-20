// Verificación por HTTP contra una API levantada en local (no corre en la suite normal).
//   node test/admin-roles.http-check.js http://localhost:3300
// - Toma TODAS las rutas admin/* de Swagger.
// - Token de cliente: cada ruta (GET, POST, PUT, PATCH, DELETE) debe responder 403 por rol.
//   SEGURIDAD: antes de mandar cualquier escritura comprueba que admin/* ya rechaza al cliente;
//   si no (código sin el arreglo), se detiene sin escribir nada. Los :id van con 999999999.
// - Token de admin: solo GET (para no modificar datos); no debe responder 401/403.
// - Regresión: el cliente sigue entrando a sus propias rutas.
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const BASE = process.argv[2] || 'http://localhost:3300';
const sign = (p) => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '10m' });
const CLIENT = sign({ sub: 1, email: 'andrea.cevallos@comercialandina.ec', role: 'account_user', accountId: 1 });
const ADMIN = sign({ sub: 1, email: 'admin@facturaec.com', role: 'platform_admin' });
const ROLE_MSG = 'No tiene permisos para acceder a esta sección.';

(async () => {
  const spec = await (await fetch(`${BASE}/api/docs-json`)).json();
  const routes = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!path.startsWith('/api/v1/admin')) continue;
    for (const m of Object.keys(ops)) routes.push({ method: m.toUpperCase(), path: path.replace(/\{[^}]+\}/g, '999999999') });
  }
  let fails = 0;
  const call = async (method, path, token) => {
    const r = await fetch(BASE + path, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: ['GET', 'DELETE'].includes(method) ? undefined : '{}',
    });
    let body = {}; try { body = await r.json(); } catch {}
    return { status: r.status, message: body.message };
  };

  // Canario: si un cliente puede leer admin/*, el hueco está abierto y NO se mandan escrituras.
  const canary = await call('GET', '/api/v1/admin/accounts', CLIENT);
  if (!(canary.status === 403 && canary.message === ROLE_MSG)) {
    console.log(`DETENIDO: un cliente obtiene ${canary.status} en GET /admin/accounts. admin/* está abierto; no se envían escrituras.`);
    process.exit(2);
  }

  let clientOk = 0, adminOk = 0, adminGets = 0;
  for (const { method, path } of routes) {
    const c = await call(method, path, CLIENT);
    if (c.status === 403 && c.message === ROLE_MSG) clientOk++;
    else { fails++; console.log(`FALLA cliente ${method} ${path} → ${c.status} ${JSON.stringify(c.message)}`); }
    if (method === 'GET') {
      adminGets++;
      const a = await call(method, path, ADMIN);
      if (a.status !== 401 && a.status !== 403) adminOk++;
      else { fails++; console.log(`FALLA admin ${method} ${path} → ${a.status} ${JSON.stringify(a.message)}`); }
    }
  }
  const sinToken = await fetch(`${BASE}/api/v1/admin/accounts`);
  if (sinToken.status !== 401) { fails++; console.log(`FALLA sin token → ${sinToken.status}`); }
  const propias = [];
  for (const path of ['/api/v1/client/profile', '/api/v1/client/users', '/api/v1/client/billing', '/api/v1/client/dashboard']) {
    const r = await call('GET', path, CLIENT);
    propias.push(`${path.replace('/api/v1', '')} ${r.status}`);
    if (r.status === 401 || r.status === 403) { fails++; console.log(`FALLA cliente en su ruta ${path} → ${r.status}`); }
  }
  const login = await fetch(`${BASE}/api/v1/auth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@facturaec.com', password: 'admin123' }) });
  const loginBody = await login.json().catch(() => ({}));
  if (!loginBody.accessToken && !loginBody.access_token) { fails++; console.log(`FALLA login admin → ${login.status}`); }
  else {
    const t = loginBody.accessToken || loginBody.access_token;
    const r = await call('GET', '/api/v1/admin/accounts', t);
    if (r.status !== 200) { fails++; console.log(`FALLA admin con token real de login → ${r.status}`); }
  }

  console.log(`Rutas admin/* en Swagger: ${routes.length}`);
  console.log(`Cliente → 403 por rol: ${clientOk}/${routes.length}`);
  console.log(`Admin entra (GET): ${adminOk}/${adminGets}`);
  console.log(`Sin token → 401: ${sinToken.status}`);
  console.log(`Cliente en sus propias rutas: ${propias.join(', ')}`);
  console.log(`Login real de admin + GET /admin/accounts: ${login.status}`);
  console.log(fails ? `RESULTADO: ${fails} FALLAS` : 'RESULTADO: OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
