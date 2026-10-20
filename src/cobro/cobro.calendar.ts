/**
 * Calendario de cobro (Manuel, 19-oct-2026), contado desde el día de cierre del ciclo:
 *   cierre      → se cierra el período y llega el correo con «Pagar ahora»
 *   cierre + 5  → vence; aviso en el panel que se puede cerrar
 *   cierre + 10 → panel bloqueado: solo puede pagar (la API sigue emitiendo)
 *   cierre + 20 → cuenta bloqueada: se corta la emisión por API
 * Desde que el panel se bloquea no se envían más correos de cobro.
 */
export const DIAS_VENCIMIENTO = 5;
export const DIAS_BLOQUEO_PANEL = 10;
export const DIAS_CORTE_API = 20;

/** Fecha local (hora del servidor, Ecuador) en formato YYYY-MM-DD. */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** YYYY-MM-DD → fecha local a medianoche. */
export function fromYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + days);
  return r;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Días enteros de `a` a `b` (b − a), sin importar la hora. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round(
    (startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000,
  );
}

/** El día de corte en un mes dado, ajustado a la longitud del mes (corte 31 en febrero → 28/29). */
function cycleDateIn(year: number, month: number, cycleDay: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(cycleDay, last));
}

/**
 * Ciclo vigente que contiene `today`: desde el último día de corte (incluido) hasta el
 * siguiente (excluido).
 */
export function currentCycle(
  today: Date,
  cycleDay: number,
): { start: Date; end: Date } {
  const t = startOfDay(today);
  let start = cycleDateIn(t.getFullYear(), t.getMonth(), cycleDay);
  if (start > t)
    start = cycleDateIn(t.getFullYear(), t.getMonth() - 1, cycleDay);
  const end = cycleDateIn(start.getFullYear(), start.getMonth() + 1, cycleDay);
  return { start, end };
}

/** Un ciclo antes de la fecha de cierre `closing` (inicio del período que se cierra hoy). */
export function previousCycleStart(closing: Date, cycleDay: number): Date {
  const c = startOfDay(closing);
  return cycleDateIn(c.getFullYear(), c.getMonth() - 1, cycleDay);
}

/** Etapa de cobranza de una deuda según su fecha de vencimiento. */
export type EtapaCobro =
  | 'al_dia'
  | 'vencido'
  | 'panel_bloqueado'
  | 'api_cortada';

export function etapaCobro(dueDate: Date | string, today: Date): EtapaCobro {
  const due =
    typeof dueDate === 'string' ? fromYmd(dueDate) : startOfDay(dueDate);
  const late = daysBetween(due, today); // 0 = vence hoy
  const panel = DIAS_BLOQUEO_PANEL - DIAS_VENCIMIENTO;
  const api = DIAS_CORTE_API - DIAS_VENCIMIENTO;
  if (late >= api) return 'api_cortada';
  if (late >= panel) return 'panel_bloqueado';
  if (late >= 0) return 'vencido';
  return 'al_dia';
}

/** Fechas clave de una deuda a partir de su vencimiento. */
export function fechasCobro(dueDate: string) {
  const due = fromYmd(dueDate);
  return {
    vence: ymd(due),
    bloqueoPanel: ymd(addDays(due, DIAS_BLOQUEO_PANEL - DIAS_VENCIMIENTO)),
    corteApi: ymd(addDays(due, DIAS_CORTE_API - DIAS_VENCIMIENTO)),
  };
}
