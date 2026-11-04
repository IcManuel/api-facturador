/**
 * Format a Date to ISO-like string in a specific timezone.
 * Output: "2026-03-06T15:19:10.000-05:00"
 *
 * Uses Intl.DateTimeFormat to get the correct offset and parts.
 */
export function formatDateTz(date: Date | string | null | undefined, timezone = 'America/Guayaquil'): string | null {
  if (!date) return null;

  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return null;

  // Get parts in the target timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3,
  });

  const parts = formatter.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  const second = get('second');
  const ms = get('fractionalSecond');

  // Calculate the UTC offset for this timezone at this moment
  const tzDate = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
  const offsetMs = tzDate.getTime() - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  const offsetHours = Math.floor(Math.abs(offsetMs) / 3_600_000);
  const offsetMinutes = Math.floor((Math.abs(offsetMs) % 3_600_000) / 60_000);
  const offsetSign = offsetMs >= 0 ? '+' : '-';
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${offsetStr}`;
}

/** Zona horaria de la plataforma: todo se muestra y se agrupa en hora de Ecuador (GMT-5). */
export const EC_TZ = 'America/Guayaquil';

/** Fecha YYYY-MM-DD de un instante en hora de Ecuador (por defecto, hoy). */
export function ymdEc(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
