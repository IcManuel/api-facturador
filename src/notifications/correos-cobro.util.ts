import { AccountType } from '../entities/enums';

interface EmpresaCorreos {
  email: string | null;
  notificationEmail: string | null;
  isActive?: boolean;
}

/**
 * Empresas que reciben copia de los correos de la cuenta (cobros, vencimientos, pagos, bloqueos).
 * En una cuenta multiempresa el que paga es el titular: sus empresas suelen ser clientes del
 * integrador y no deben recibir su cobro, así que esos correos van solo al correo de la cuenta.
 */
export function empresasConCopia(
  accountType: AccountType,
  companies: EmpresaCorreos[] | null | undefined,
): { email: string | null; notificationEmail: string | null }[] {
  if (accountType === AccountType.MULTI) return [];
  return (companies ?? [])
    .filter((c) => c.isActive !== false)
    .map((c) => ({ email: c.email, notificationEmail: c.notificationEmail }));
}
