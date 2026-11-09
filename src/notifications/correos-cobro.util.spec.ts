import { AccountType } from '../entities/enums';
import { empresasConCopia } from './correos-cobro.util';

describe('empresasConCopia', () => {
  const empresas = [
    { email: 'gerencia@qvet.ec', notificationEmail: 'alertas@qvet.ec', isActive: true },
    { email: 'inactiva@x.ec', notificationEmail: null, isActive: false },
  ];

  it('multiempresa: las empresas no reciben los correos de cobro del titular', () => {
    expect(empresasConCopia(AccountType.MULTI, empresas)).toEqual([]);
  });

  it('empresa única: recibe copia, sin las empresas inactivas', () => {
    expect(empresasConCopia(AccountType.SINGLE, empresas)).toEqual([
      { email: 'gerencia@qvet.ec', notificationEmail: 'alertas@qvet.ec' },
    ]);
  });

  it('tolera una cuenta sin empresas cargadas', () => {
    expect(empresasConCopia(AccountType.SINGLE, undefined)).toEqual([]);
  });
});
