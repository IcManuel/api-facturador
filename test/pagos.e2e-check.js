/* eslint-disable */
// Escenarios de cobro con PagoPlux contra la BASE LOCAL (nunca producción).
//   npx nest build && node test/pagos.e2e-check.js
// Levanta la API compilada en el puerto 3301, sin correo (SMTP_HOST vacío), crea cuentas de
// prueba propias y las borra al terminar. Los avisos se mandan firmados como los reenvía Mila.
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

if (process.env.DB_HOST !== 'localhost' && process.env.DB_HOST !== '127.0.0.1') {
  console.error(`DETENIDO: DB_HOST=${process.env.DB_HOST}. Este script solo corre contra la base local.`);
  process.exit(2);
}
const SECRETO = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  SMTP_HOST: '', // sin correo real: el servicio usa el transporte de desarrollo
  PAGOPLUX_HABILITADO: 'true',
  PAGOPLUX_AMBIENTE: 'sandbox',
  PAGOPLUX_AVISOS: 'mila',
  PAGOPLUX_REENVIO_SECRETO: SECRETO,
});

const { NestFactory } = require('@nestjs/core');
const { ValidationPipe, Logger } = require('@nestjs/common');
const jwt = require('jsonwebtoken');
const { AppModule } = require('../dist/app.module');
const { BillingService } = require('../dist/admin/billing/billing.service');
const { CobranzaCron } = require('../dist/pagos/cobranza.cron');

const PORT = 3301;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const CEDULA = '0706410164'; // la de Manuel (cédula real, solo en local; nunca va a Plux)
let fails = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? 'OK   ' : 'FALLA'} ${msg}${!cond && extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  if (!cond) fails++;
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() + n); return r; };

(async () => {
  Logger.overrideLogger(['error']);
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error'] });
  app.set('trust proxy', 'loopback');
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(PORT, '127.0.0.1');
  const ds = app.get(require('typeorm').DataSource);
  const q = (sql, p) => ds.query(sql, p);
  const created = { acc: [] };
  const token = (aus, acc) => jwt.sign({ sub: aus, email: `pagos${aus}@prueba.local`, role: 'account_user', accountId: acc }, process.env.JWT_SECRET, { expiresIn: '15m' });

  async function cuenta(nombre, { status = 'active', trialEndsAt = null, cycleDay = 1, planId = 7, empresas = 1, pricing = null } = {}) {
    const suf = crypto.randomBytes(4).toString('hex');
    const [a] = await q(`INSERT INTO app.account (acc_name, acc_ruc, acc_email, acc_status, acc_trial_ends_at, acc_billing_cycle_day, acc_type, acc_integrator_pricing)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING acc_id`,
      [`PRUEBA PAGOS ${nombre}`, `09${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 900 + 100)}`.slice(0, 13), `pagos-${suf}@prueba.local`, status, trialEndsAt, cycleDay, empresas > 1 ? 'multi' : 'single', pricing ? JSON.stringify(pricing) : null]);
    created.acc.push(a.acc_id);
    const ak = `ak_test_${crypto.randomBytes(16).toString('hex')}`;
    await q(`UPDATE app.account SET acc_api_key = $2 WHERE acc_id = $1`, [a.acc_id, ak]);
    const [u] = await q(`INSERT INTO app.account_user (acc_id, aus_name, aus_email, aus_password_hash, aus_role) VALUES ($1, $2, $3, 'x', 'admin') RETURNING aus_id`,
      [a.acc_id, `Usuario Prueba ${nombre}`, `pagos-${suf}@prueba.local`]);
    const companies = [];
    for (let i = 0; i < empresas; i++) {
      const sk = `sk_test_${crypto.randomBytes(16).toString('hex')}`;
      const [c] = await q(`INSERT INTO app.company (acc_id, spl_id, com_name, com_ruc, com_api_key, com_email) VALUES ($1, $2, $3, $4, $5, $6) RETURNING com_id`,
        [a.acc_id, planId, `Empresa ${nombre} ${i + 1}`, `07064101640${String(i + 1).padStart(2, '0')}`.slice(0, 13), sk, `pagos-${suf}@prueba.local`]);
      companies.push({ id: c.com_id, sk });
    }
    return { id: a.acc_id, aus: u.aus_id, jwt: token(u.aus_id, a.acc_id), ak, companies };
  }
  async function periodo(accId, total, dueDate) {
    const [p] = await q(`INSERT INTO app.billing_period (acc_id, spl_id, bpe_year, bpe_month, bpe_period_start_date, bpe_period_end_date, bpe_total, bpe_subtotal, bpe_iva, bpe_due_date, bpe_closed_at, bpe_status)
      VALUES ($1, 7, 2026, 10, $2::date - 35, $2::date - 6, $3, round($3 / 1.15, 2), $3 - round($3 / 1.15, 2), $2, now(), 'pending') RETURNING bpe_id`,
      [accId, dueDate, total]);
    return p.bpe_id;
  }
  const call = async (method, p, jwtTok, body, headers = {}) => {
    const r = await fetch(B + p, {
      method, headers: { ...(jwtTok ? { Authorization: `Bearer ${jwtTok}` } : {}), 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const aviso = async (payload, secreto = SECRETO) => {
    const raw = JSON.stringify(payload);
    const firma = crypto.createHmac('sha256', secreto).update(raw).digest('hex');
    return call('POST', '/pagos/plux/aviso', null, raw, { 'X-Mila-Firma': firma, 'X-Reenviado-Por': 'mila' });
  };
  const avisoDe = (extras, amount, state = 'PAGADO', tx = `TX${crypto.randomBytes(6).toString('hex')}`) => ({
    amount, state, id_transaccion: tx, token: `V${crypto.randomBytes(4).toString('hex')}`, cardInfo: '4540 63XX XXXX 8783',
    cardIssuer: 'VISA', cardType: 'credit', clientID: CEDULA, clientName: 'John Doe', extras, typePayment: 'TARJETA', date: new Date().toISOString(),
  });
  const pagador = { identificacion: CEDULA, telefono: '0991234567', direccion: 'Av. Amazonas N39-123, Quito' };
  const today = new Date();
  const cobranza = app.get(CobranzaCron);
  const billing = app.get(BillingService);

  try {
    // ── 1. Calendario de cobranza ────────────────────────────────────────────
    console.log('\n── Calendario de cobranza');
    const A = await cuenta('A (vence hoy)');
    await periodo(A.id, 6.35, ymd(today));
    const P = await cuenta('P (+10: panel)');
    await periodo(P.id, 6.35, ymd(addDays(today, -5)));
    const X = await cuenta('X (+20: API)');
    await periodo(X.id, 12.7, ymd(addDays(today, -15)));
    const E = await cuenta('E (al día)');
    await periodo(E.id, 5, ymd(addDays(today, 3)));

    ok((await call('GET', '/client/billing/pago/estado', A.jwt)).body?.bloqueo === 'aviso', 'A vencida hoy: aviso que se puede cerrar');
    ok((await call('GET', '/client/billing/pago/estado', E.jwt)).body?.bloqueo === 'ninguno', 'E al día: sin aviso');
    const r = await cobranza.ejecutar(today);
    ok(r.avisados.some((l) => l.includes(`cuenta ${A.id}`)), 'A recibe el correo «venció hoy» (el único correo de cobranza)');
    ok(r.panel.some((l) => l.includes(`cuenta ${P.id}`)), 'P (+10): panel bloqueado, sin correo');
    ok(r.cortadas.some((l) => l.includes(`cuenta ${X.id}`)), 'X (+20): emisión por API cortada');
    ok(!r.avisados.concat(r.panel, r.cortadas).some((l) => l.includes(`cuenta ${E.id}`)), 'E al día: nada');

    let s = await call('GET', '/client/companies', P.jwt);
    ok(s.status === 403 && s.body?.code === 'PAGO_REQUERIDO', 'P: el panel responde 403 PAGO_REQUERIDO', s);
    ok((await call('GET', '/client/billing/pago/estado', P.jwt)).body?.bloqueo === 'panel', 'P: puede ver su estado de cobro');
    ok((await call('GET', '/company', null, undefined, { 'X-API-Key': P.companies[0].sk })).status === 200, 'P: la API de emisión sigue funcionando');
    ok((await call('GET', '/company', null, undefined, { 'X-API-Key': X.companies[0].sk })).status === 401, 'X: la API de emisión está cortada');
    ok((await call('GET', '/client/billing/pago/estado', X.jwt)).body?.bloqueo === 'total', 'X: puede entrar a pagar (bloqueo total)');
    s = await call('GET', '/client/companies', X.jwt);
    ok(s.status === 403 && s.body?.code === 'PAGO_REQUERIDO', 'X: /client/companies con el token del panel también se bloquea', s.status);
    ok((await call('GET', '/client/companies', null, undefined, { 'X-Account-Key': X.ak })).status === 401, 'X: la Account Key (integración) está cortada');
    ok((await call('GET', '/client/companies', null, undefined, { 'X-Account-Key': P.ak })).status === 200, 'P: la Account Key sigue funcionando con solo el panel bloqueado');

    const r2 = await cobranza.ejecutar(today);
    ok(!r2.panel.concat(r2.cortadas).some((l) => l.includes(`cuenta ${P.id}`) || l.includes(`cuenta ${X.id}`)), 'Bloqueadas: no se repiten ni reciben más correos');

    // ── 2. Pago de la deuda (P, panel bloqueado) ─────────────────────────────
    console.log('\n── Pago de la deuda');
    s = await call('POST', '/client/billing/pago', P.jwt, { ...pagador, identificacion: '0706410165' });
    ok(s.body?.ok === false && /cédula/.test(s.body?.msg), 'Cédula con dígito verificador incorrecto: se rechaza', s.body);
    s = await call('POST', '/client/billing/pago', P.jwt, { ...pagador, telefono: '123' });
    ok(s.body?.ok === false && /celular/.test(s.body?.msg), 'Celular inválido: se rechaza');
    const p1 = await call('POST', '/client/billing/pago', P.jwt, pagador);
    ok(p1.body?.ok && p1.body.paybox.PayboxBase12 === '6.35' && p1.body.paybox.PayboxBase0 === '0.00', 'Monto del servidor: $6.35 con IVA incluido en PayboxBase12', p1.body);
    ok(p1.body?.paybox?.PayboxRecurrent === false, 'Pago único (PayboxRecurrent: false)');
    const extras = p1.body.paybox.PayboxExtras;
    ok(/^autorizadorec\|AE[0-9a-f]{24}$/.test(extras), 'PayboxExtras = autorizadorec|<id imposible de adivinar>', extras);
    const p1b = await call('POST', '/client/billing/pago', P.jwt, pagador);
    ok(p1b.body?.pagoId === p1.body.pagoId, 'Otra pestaña con los mismos datos: el MISMO intento (no se cobra doble)');

    s = await aviso(avisoDe(extras, '6.35'), 'otro-secreto-que-no-es-el-de-mila-0123456789abcdef');
    ok(s.status === 401, 'Aviso con firma inválida: 401 y no se registra nada');
    s = await call('POST', '/pagos/plux/aviso', null, JSON.stringify(avisoDe(extras, '6.35')));
    ok(s.status === 401, 'Aviso sin firma: 401');
    ok((await q(`SELECT count(*)::int n FROM app.payment_notification WHERE pno_extras = $1`, [extras]))[0].n === 0, 'Ningún aviso falso quedó registrado');

    s = await aviso(avisoDe(extras, '6.35', 'ERROR'));
    ok(s.status === 200 && s.body?.legacyStatus === 'APPLIED', 'Aviso de rechazo: 200 con la respuesta que espera Plux');
    ok((await call('GET', `/client/billing/pago/${p1.body.pagoId}`, P.jwt)).body?.estado === 'RECHAZADO', 'Tarjeta rechazada: intento RECHAZADO');
    ok((await call('POST', `/client/billing/pago/${p1.body.pagoId}/reportar`, P.jwt)).body?.estado === 'REPORTADO', 'Reintento con otra tarjeta: el navegador reporta (no activa nada)');
    s = await call('GET', '/client/companies', P.jwt);
    ok(s.status === 403, 'El reporte del navegador NO desbloquea');

    const tx = `TX${crypto.randomBytes(6).toString('hex')}`;
    s = await aviso(avisoDe(extras, '6.35', 'PAGADO', tx));
    ok(s.status === 200, 'Aviso de cobro aprobado: 200');
    const est = await call('GET', `/client/billing/pago/${p1.body.pagoId}`, P.jwt);
    ok(est.body?.estado === 'PAGADO' && est.body?.tarjeta === '8783', 'Intento PAGADO (tarjeta solo con los 4 últimos)', est.body);
    const pays = await q(`SELECT pay_amount, pay_method, pin_id FROM app.payment WHERE acc_id = $1`, [P.id]);
    ok(pays.length === 1 && Number(pays[0].pay_amount) === 6.35 && pays[0].pay_method === 'pagoplux' && pays[0].pin_id === p1.body.pagoId, 'Pago registrado en el período (método pagoplux, ligado al intento)', pays);
    ok((await call('GET', '/client/companies', P.jwt)).status === 200, 'P: el panel se desbloquea solo');
    const ac = (await q(`SELECT acc_status, acc_payment_lock FROM app.account WHERE acc_id = $1`, [P.id]))[0];
    ok(ac.acc_status === 'active' && ac.acc_payment_lock === null, 'P: cuenta activa, sin bloqueo');

    s = await aviso(avisoDe(extras, '6.35', 'PAGADO', tx));
    ok(s.status === 200, 'Plux reintenta el mismo aviso: 200');
    ok((await q(`SELECT count(*)::int n FROM app.payment WHERE acc_id = $1`, [P.id]))[0].n === 1, 'Aviso repetido: no se registra un segundo pago');
    s = await aviso(avisoDe(extras, '6.35', 'PAGADO'));
    ok((await q(`SELECT count(*)::int n FROM app.payment WHERE acc_id = $1`, [P.id]))[0].n === 1, 'Segundo cobro del mismo intento (otra transacción): no se aplica, alerta de doble cobro');
    const pno = await q(`SELECT pno_payload FROM app.payment_notification WHERE pno_extras = $1 LIMIT 1`, [extras]);
    ok(pno.length && !JSON.stringify(pno[0].pno_payload).includes(CEDULA) && !JSON.stringify(pno[0].pno_payload).includes('John'), 'El aviso guardado no tiene cédula ni nombre del tarjetahabiente');

    // ── 3. Monto distinto y cuenta con la API cortada (X) ────────────────────
    console.log('\n── Monto alterado y API cortada');
    const x1 = await call('POST', '/client/billing/pago', X.jwt, pagador);
    ok(x1.body?.paybox?.PayboxBase12 === '12.70', 'X debe $12.70');
    await aviso(avisoDe(x1.body.paybox.PayboxExtras, '1.00'));
    ok((await call('GET', `/client/billing/pago/${x1.body.pagoId}`, X.jwt)).body?.estado === 'ERROR', 'Plux cobra otro monto: intento ERROR, nada se aplica');
    ok((await q(`SELECT count(*)::int n FROM app.payment WHERE acc_id = $1`, [X.id]))[0].n === 0, 'Sin pago registrado con el monto alterado');
    const x2 = await call('POST', '/client/billing/pago', X.jwt, pagador);
    ok(x2.body?.ok && x2.body.pagoId !== x1.body.pagoId, 'Puede iniciar un pago nuevo');
    await aviso(avisoDe(x2.body.paybox.PayboxExtras, '12.70')); // llega ANTES del reporte del navegador
    ok((await call('GET', `/client/billing/pago/${x2.body.pagoId}`, X.jwt)).body?.estado === 'PAGADO', 'El aviso llega antes que el reporte del navegador: igual se aplica');
    ok((await call('GET', '/company', null, undefined, { 'X-API-Key': X.companies[0].sk })).status === 200, 'X: la API de emisión vuelve a funcionar al pagar');

    // ── 4. Fin de la demo: activación pagando el primer mes ──────────────────
    console.log('\n── Fin de la demo');
    const D = await cuenta('D (demo vencida)', { status: 'trial', trialEndsAt: addDays(today, -1), planId: 1 });
    s = await call('GET', '/client/companies', D.jwt);
    ok(s.status === 403 && s.body?.code === 'PAGO_REQUERIDO', 'Demo vencida: el panel solo deja activar');
    const ed = (await call('GET', '/client/billing/pago/estado', D.jwt)).body;
    ok(ed?.bloqueo === 'demo' && ed.activacion?.puedeElegirPlan && ed.activacion.planes.some((p) => p.name === 'Profesional'), 'Estado: demo, con los planes para elegir', ed);
    const d1 = await call('POST', '/client/billing/pago', D.jwt, { ...pagador, planId: 2 });
    ok(d1.body?.paybox?.PayboxBase12 === '20.00', 'Elige Profesional: paga $20.00 (primer mes)', d1.body);
    await aviso(avisoDe(d1.body.paybox.PayboxExtras, '20.00'));
    const dacc = (await q(`SELECT acc_status, acc_trial_ends_at, acc_billing_cycle_day FROM app.account WHERE acc_id = $1`, [D.id]))[0];
    ok(dacc.acc_status === 'active' && dacc.acc_trial_ends_at === null && dacc.acc_billing_cycle_day === Math.min(today.getDate(), 28), 'Cuenta activa sola, corte = día del pago', dacc);
    ok((await q(`SELECT spl_id FROM app.company WHERE acc_id = $1`, [D.id]))[0].spl_id === 2, 'La empresa quedó en el plan elegido');
    const pre = (await q(`SELECT bpe_id, bpe_prepaid, bpe_closed_at, bpe_status, bpe_total, to_char(bpe_period_start_date,'YYYY-MM-DD') s FROM app.billing_period WHERE acc_id = $1`, [D.id]));
    ok(pre.length === 1 && pre[0].bpe_prepaid && pre[0].bpe_closed_at === null && pre[0].bpe_status === 'paid' && Number(pre[0].bpe_total) === 20, 'Primer mes: período abierto y pagado', pre);
    ok((await call('GET', '/client/companies', D.jwt)).status === 200, 'Ya puede usar el panel');
    // Al cerrar el ciclo, el período prepagado se completa (no se cobra la cuota dos veces)
    const cycle = Math.min(today.getDate(), 28);
    const next = new Date(today.getFullYear(), today.getMonth() + 1, cycle);
    await billing.closeAnniversaryPeriodsForToday(next);
    const post = await q(`SELECT bpe_status, bpe_total, bpe_paid_amount, bpe_closed_at FROM app.billing_period WHERE acc_id = $1`, [D.id]);
    ok(post.length === 1 && post[0].bpe_closed_at && post[0].bpe_status === 'paid' && Number(post[0].bpe_total) === 20, 'Al cierre: el mismo período se completa, sin cobrar la cuota otra vez', post);

    // ── 5. Integrador con tarifa propia ──────────────────────────────────────
    console.log('\n── Integrador (tarifa propia)');
    const day = 15;
    const I = await cuenta('I (integrador)', { cycleDay: day, empresas: 3, pricing: { tramos: [{ hasta: 20, precio: 3 }, { hasta: 50, precio: 2.5 }, { hasta: null, precio: 2 }], porDocumento: 0.05 } });
    const closing = new Date(today.getFullYear(), today.getMonth() + 1, day);
    await billing.closeAnniversaryPeriodsForToday(closing);
    const ip = (await q(`SELECT bpe_total, bpe_subtotal, bpe_iva, to_char(bpe_due_date,'YYYY-MM-DD') due, bpe_status FROM app.billing_period WHERE acc_id = $1`, [I.id]));
    ok(ip.length === 1 && Number(ip[0].bpe_total) === 9 && Number(ip[0].bpe_subtotal) === 7.83 && Number(ip[0].bpe_iva) === 1.17, '3 empresas × $3 = $9,00 ($7,83 + $1,17 de IVA)', ip);
    ok(ip[0]?.due === ymd(addDays(closing, 5)), 'Vence 5 días después del cierre');
    ok((await q(`SELECT count(*)::int n FROM app.billing_company_detail bcd JOIN app.billing_period bp USING (bpe_id) WHERE bp.acc_id = $1`, [I.id]))[0].n === 3, 'Detalle por empresa guardado al cerrar');
    await billing.closeAnniversaryPeriodsForToday(closing);
    ok((await q(`SELECT count(*)::int n FROM app.billing_period WHERE acc_id = $1`, [I.id]))[0].n === 1, 'Cerrar dos veces el mismo día no duplica el período');

    // ── 6. Admin: tarifa de integrador y pagos en línea ──────────────────────
    console.log('\n── Admin');
    const ADMIN = jwt.sign({ sub: 1, email: 'admin@facturaec.com', role: 'platform_admin' }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const T = await cuenta('T (tarifa)', { cycleDay: day, empresas: 2 });
    s = await call('PUT', `/admin/accounts/${T.id}/integrator-pricing`, ADMIN, { tramos: [{ hasta: null, precio: 3 }, { hasta: null, precio: 2 }], porDocumento: 0.05 });
    ok(s.status === 400 && /tramo abierto/.test(JSON.stringify(s.body)), 'Tarifa con dos tramos abiertos: se rechaza', s.body);
    s = await call('PUT', `/admin/accounts/${T.id}/integrator-pricing`, ADMIN, { tramos: [{ hasta: 20, precio: 3 }, { hasta: 20, precio: 2 }, { hasta: null, precio: 1 }], porDocumento: 0.05 });
    ok(s.status === 400, 'Tarifa con límites repetidos: se rechaza');
    s = await call('PUT', `/admin/accounts/${T.id}/integrator-pricing`, ADMIN, { tramos: [{ hasta: null, precio: 2 }, { hasta: 1, precio: 4 }], porDocumento: 0.1 });
    ok(s.status === 200 && s.body?.empresasActivas === 2 && s.body?.precioPorEmpresa === 2 && s.body?.cuotaMensual === 4, 'Tarifa guardada (tramos desordenados se ordenan): vista previa 2 × $2 = $4', s.body);
    ok((await call('PUT', `/admin/accounts/${T.id}/integrator-pricing`, T.jwt, { tramos: [{ hasta: null, precio: 0 }], porDocumento: 0 })).status === 403, 'Un cliente no puede cambiar su tarifa (403)');
    await billing.closeAnniversaryPeriodsForToday(closing);
    ok(Number((await q(`SELECT bpe_total FROM app.billing_period WHERE acc_id = $1`, [T.id]))[0]?.bpe_total) === 4, 'El cierre usa la tarifa asignada desde el admin ($4,00)');
    s = await call('DELETE', `/admin/accounts/${T.id}/integrator-pricing`, ADMIN);
    ok(s.status === 200 && s.body?.pricing === null, 'Tarifa quitada: vuelve a los planes');

    s = await call('GET', '/admin/pagos/resumen', ADMIN);
    ok(s.status === 200 && s.body?.errores >= 1 && s.body?.pagadosMes >= 3, 'Resumen de pagos: cuenta el pago con error y los confirmados', s.body);
    s = await call('GET', '/admin/pagos/intentos?status=ERROR', ADMIN);
    ok(s.body?.data?.some((i) => i.id === x1.body.pagoId && i.status === 'ERROR'), 'Lista «Por revisar»: aparece el pago con monto distinto');
    s = await call('GET', `/admin/pagos/intentos/${p1.body.pagoId}`, ADMIN);
    ok(s.body?.pagos?.length === 1 && s.body?.avisos?.length >= 3 && s.body?.status === 'PAGADO', 'Detalle: el pago registrado y todos sus avisos (rechazo, cobro, repetidos)', { pagos: s.body?.pagos?.length, avisos: s.body?.avisos?.length });
    s = await call('GET', '/admin/pagos/avisos?result=MONTO', ADMIN);
    ok(s.body?.data?.some((a) => a.result === 'MONTO'), 'Avisos sin resolver: aparece el de monto distinto');
    ok((await call('GET', '/admin/pagos/resumen', P.jwt)).status === 403, 'Un cliente no ve los pagos de otros (403)');
  } finally {
    // ── Limpieza: solo lo creado por este script ──
    if (created.acc.length) {
      const ids = created.acc;
      await q(`DELETE FROM app.payment WHERE acc_id = ANY($1)`, [ids]);
      await q(`DELETE FROM app.payment_notification WHERE pin_id IN (SELECT pin_id FROM app.payment_intent WHERE acc_id = ANY($1)) OR pno_extras LIKE 'autorizadorec|%' AND pin_id IS NULL AND pno_created_at > now() - interval '1 hour'`, [ids]);
      await q(`DELETE FROM app.payment_intent WHERE acc_id = ANY($1)`, [ids]);
      await q(`DELETE FROM app.billing_company_detail WHERE bpe_id IN (SELECT bpe_id FROM app.billing_period WHERE acc_id = ANY($1))`, [ids]);
      await q(`DELETE FROM app.billing_period WHERE acc_id = ANY($1)`, [ids]);
      await q(`DELETE FROM app.emission_point WHERE com_id IN (SELECT com_id FROM app.company WHERE acc_id = ANY($1))`, [ids]).catch(() => {});
      await q(`DELETE FROM app.establishment WHERE com_id IN (SELECT com_id FROM app.company WHERE acc_id = ANY($1))`, [ids]).catch(() => {});
      await q(`DELETE FROM app.company WHERE acc_id = ANY($1)`, [ids]);
      await q(`DELETE FROM app.account_user WHERE acc_id = ANY($1)`, [ids]);
      await q(`DELETE FROM app.account WHERE acc_id = ANY($1)`, [ids]);
      const quedan = (await q(`SELECT count(*)::int n FROM app.account WHERE acc_name LIKE 'PRUEBA PAGOS %'`))[0].n;
      console.log(`\nLimpieza: ${ids.length} cuentas de prueba borradas; quedan ${quedan}`);
    }
    await app.close();
  }
  console.log(fails ? `\nRESULTADO: ${fails} FALLAS` : '\nRESULTADO: OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
