import {
  currentCycle,
  etapaCobro,
  fechasCobro,
  previousCycleStart,
  ymd,
  fromYmd,
  addDays,
} from './cobro.calendar';

const d = (s: string) => fromYmd(s);

describe('calendario de cobro', () => {
  it('ciclo vigente desde el último día de corte', () => {
    const c = currentCycle(d('2026-10-19'), 6);
    expect([ymd(c.start), ymd(c.end)]).toEqual(['2026-10-06', '2026-11-06']);
  });

  it('el día de corte inicia un ciclo nuevo', () => {
    const c = currentCycle(d('2026-10-06'), 6);
    expect(ymd(c.start)).toBe('2026-10-06');
  });

  it('antes del día de corte el ciclo viene del mes anterior', () => {
    expect(ymd(currentCycle(d('2026-10-03'), 6).start)).toBe('2026-09-06');
  });

  it('corte 31 se ajusta a meses cortos', () => {
    expect(ymd(currentCycle(d('2026-02-28'), 31).start)).toBe('2026-02-28');
    expect(ymd(currentCycle(d('2026-03-15'), 31).start)).toBe('2026-02-28');
    expect(ymd(previousCycleStart(d('2026-03-31'), 31))).toBe('2026-02-28');
  });

  it('cruza el fin de año', () => {
    const c = currentCycle(d('2027-01-02'), 19);
    expect([ymd(c.start), ymd(c.end)]).toEqual(['2026-12-19', '2027-01-19']);
  });

  it('etapas: cierre+5 vence, +10 panel, +20 API', () => {
    const cierre = d('2026-11-06');
    const due = addDays(cierre, 5);
    const at = (n: number) => etapaCobro(due, addDays(cierre, n));
    expect([
      at(0),
      at(4),
      at(5),
      at(9),
      at(10),
      at(19),
      at(20),
      at(60),
    ]).toEqual([
      'al_dia',
      'al_dia',
      'vencido',
      'vencido',
      'panel_bloqueado',
      'panel_bloqueado',
      'api_cortada',
      'api_cortada',
    ]);
  });

  it('fechas clave para mostrar al cliente', () => {
    expect(fechasCobro('2026-11-11')).toEqual({
      vence: '2026-11-11',
      bloqueoPanel: '2026-11-16',
      corteApi: '2026-11-26',
    });
  });
});
