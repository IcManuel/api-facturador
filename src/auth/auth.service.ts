import { Injectable, UnauthorizedException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PlatformAdmin } from '../entities/platform-admin.entity';
import { AccountUser } from '../entities/account-user.entity';
import { Account } from '../entities/account.entity';
import { Company } from '../entities/company.entity';
import { EmissionPoint } from '../entities/emission-point.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { AccountType, AccountStatus, AccountUserRole, PlanTier, CompanyEnv } from '../entities/enums';
import { MailService } from '../common/services/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { RefreshTokenService } from './refresh-token.service';
import { RegisterDto } from './dto/register.dto';
import { EstablishmentsService } from '../establishments/establishments.service';

@Injectable()
export class AuthService {
  /** Días de demo para cuentas nuevas (desde el 30-sep-2026; antes eran 5). */
  static readonly TRIAL_DAYS = 15;

  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(PlatformAdmin)
    private readonly adminRepo: Repository<PlatformAdmin>,
    @InjectRepository(AccountUser)
    private readonly accountUserRepo: Repository<AccountUser>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(EmissionPoint)
    private readonly emissionPointRepo: Repository<EmissionPoint>,
    @InjectRepository(SubscriptionPlan)
    private readonly planRepo: Repository<SubscriptionPlan>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly notificationService: NotificationService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly establishmentsService: EstablishmentsService,
  ) {}

  async loginAdmin(email: string, password: string) {
    const admin = await this.adminRepo.findOne({
      where: { email, isActive: true },
      select: ['id', 'name', 'email', 'passwordHash', 'isActive'],
    });

    if (!admin) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const payload = { sub: admin.id, email: admin.email, role: 'platform_admin' as const };
    const refreshToken = await this.refreshTokenService.create(admin.id, 'platform_admin');

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken,
      user: { id: admin.id, name: admin.name, email: admin.email, role: 'platform_admin' },
    };
  }

  async loginClient(email: string, password: string) {
    const user = await this.accountUserRepo.findOne({
      where: { email, isActive: true },
      select: ['id', 'name', 'email', 'passwordHash', 'role', 'accountId'],
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const payload = {
      sub: user.id,
      email: user.email,
      role: 'account_user' as const,
      accountId: user.accountId,
    };

    const refreshToken = await this.refreshTokenService.create(user.id, 'account_user', user.accountId);

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountId: user.accountId,
      },
    };
  }

  /**
   * Issue a new access token + refresh token from a valid refresh token.
   */
  async refresh(oldRefreshToken: string) {
    const data = await this.refreshTokenService.consume(oldRefreshToken);
    if (!data) {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    // Build JWT payload based on role
    if (data.role === 'platform_admin') {
      const admin = await this.adminRepo.findOne({ where: { id: data.userId, isActive: true } });
      if (!admin) throw new UnauthorizedException('Usuario no encontrado o desactivado');

      const payload = { sub: admin.id, email: admin.email, role: 'platform_admin' as const };
      const newRefreshToken = await this.refreshTokenService.create(admin.id, 'platform_admin');

      return {
        accessToken: this.jwtService.sign(payload),
        refreshToken: newRefreshToken,
        user: { id: admin.id, name: admin.name, email: admin.email, role: 'platform_admin' },
      };
    }

    // account_user
    const user = await this.accountUserRepo.findOne({ where: { id: data.userId, isActive: true } });
    if (!user) throw new UnauthorizedException('Usuario no encontrado o desactivado');

    const payload = {
      sub: user.id,
      email: user.email,
      role: 'account_user' as const,
      accountId: user.accountId,
    };
    const newRefreshToken = await this.refreshTokenService.create(user.id, 'account_user', user.accountId);

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountId: user.accountId,
      },
    };
  }

  /**
   * Revoke a refresh token (logout).
   */
  async logout(refreshToken: string): Promise<{ message: string }> {
    await this.refreshTokenService.revoke(refreshToken);
    return { message: 'Sesión cerrada correctamente' };
  }

  /**
   * Request password reset — searches both admin and client users.
   * Always returns success (never reveals if email exists).
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    // Check client user first
    const clientUser = await this.accountUserRepo.findOne({
      where: { email, isActive: true },
    });

    if (clientUser) {
      const token = this.jwtService.sign(
        { sub: clientUser.id, email: clientUser.email, type: 'password_reset', userType: 'client' },
        { expiresIn: '15m' },
      );
      const resetUrl = this.buildResetUrl(token);
      await this.mailService.sendPasswordReset(email, clientUser.name, resetUrl);
      this.logger.log(`Password reset requested for client user: ${email}`);
      return { message: 'Si el correo existe, recibirás un enlace de recuperación.' };
    }

    // Check platform admin
    const admin = await this.adminRepo.findOne({
      where: { email, isActive: true },
    });

    if (admin) {
      const token = this.jwtService.sign(
        { sub: admin.id, email: admin.email, type: 'password_reset', userType: 'admin' },
        { expiresIn: '15m' },
      );
      const resetUrl = this.buildResetUrl(token);
      await this.mailService.sendPasswordReset(email, admin.name, resetUrl);
      this.logger.log(`Password reset requested for admin user: ${email}`);
    }

    // Always same response to prevent email enumeration
    return { message: 'Si el correo existe, recibirás un enlace de recuperación.' };
  }

  /**
   * Reset password with token.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new BadRequestException('El enlace ha expirado o es inválido. Solicita uno nuevo.');
    }

    if (payload.type !== 'password_reset') {
      throw new BadRequestException('Token inválido.');
    }

    const hash = await bcrypt.hash(newPassword, 10);

    if (payload.userType === 'client') {
      const user = await this.accountUserRepo.findOne({ where: { id: payload.sub, isActive: true } });
      if (!user) throw new BadRequestException('Usuario no encontrado.');
      user.passwordHash = hash;
      await this.accountUserRepo.save(user);
    } else if (payload.userType === 'admin') {
      const admin = await this.adminRepo.findOne({ where: { id: payload.sub, isActive: true } });
      if (!admin) throw new BadRequestException('Usuario no encontrado.');
      admin.passwordHash = hash;
      await this.adminRepo.save(admin);
    } else {
      throw new BadRequestException('Token inválido.');
    }

    this.logger.log(`Password reset completed for ${payload.email}`);
    return { message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' };
  }

  /**
   * Public self-registration — creates account + admin user with 5-day trial.
   */
  async register(dto: RegisterDto) {
    // Check RUC uniqueness
    const existingAccount = await this.accountRepo.findOne({ where: { ruc: dto.ruc } });
    if (existingAccount) {
      throw new ConflictException('Ya existe una cuenta registrada con este RUC.');
    }

    // Check email uniqueness
    const existingUser = await this.accountUserRepo.findOne({ where: { email: dto.email } });
    if (existingUser) {
      throw new ConflictException('Ya existe un usuario registrado con este correo.');
    }

    // Create account with trial status
    const trialEndsAt = new Date(Date.now() + AuthService.TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const account = this.accountRepo.create({
      name: dto.accountName,
      ruc: dto.ruc,
      email: dto.email,
      phone: dto.phone || undefined,
      type: AccountType.SINGLE,
      status: AccountStatus.TRIAL,
      trialEndsAt,
      apiKey: 'ak_' + randomBytes(32).toString('hex'),
    });
    await this.accountRepo.save(account);

    // Create admin user
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.accountUserRepo.create({
      accountId: account.id,
      name: dto.adminName,
      email: dto.email,
      passwordHash,
      role: AccountUserRole.ADMIN,
    });
    await this.accountUserRepo.save(user);

    // Create the company for this single-account, with the requested plan
    // (or basic as fallback) and a default emission point so the client can
    // configure (certificate, doc types, etc.) from their own panel right away.
    const plan = await this.resolveDefaultPlan(dto.planTier);
    const company = this.companyRepo.create({
      accountId: account.id,
      planId: plan.id,
      name: dto.accountName,
      ruc: dto.ruc,
      email: dto.email,
      phone: dto.phone || undefined,
      env: CompanyEnv.TEST,
      apiKey: 'sk_' + randomBytes(32).toString('hex'),
      billingStartDate: new Date().toISOString().slice(0, 10),
    });
    await this.companyRepo.save(company);
    const establishment = await this.establishmentsService.ensureExists(
      company.id,
      company.establishment,
    );
    await this.emissionPointRepo.save(
      this.emissionPointRepo.create({
        companyId: company.id,
        establishmentId: establishment.id,
        code: '001',
        description: 'Punto de emisión principal',
      }),
    );

    // Notify all superadmins (fire-and-forget)
    this.notifySuperadmins(account, dto.adminName, trialEndsAt).catch((err) =>
      this.logger.error(`Failed to notify superadmins about new registration: ${err.message}`),
    );

    // Auto-login
    const payload = {
      sub: user.id,
      email: user.email,
      role: 'account_user' as const,
      accountId: account.id,
    };
    const refreshToken = await this.refreshTokenService.create(user.id, 'account_user', account.id);

    this.logger.log(`New trial account registered: ${account.name} (${account.ruc})`);

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountId: account.id,
      },
    };
  }

  /**
   * Pick the plan to assign on self-registration. If a tier is requested
   * (and is self-serviceable), use that one; otherwise the active "basic"
   * plan, falling back to the cheapest active non-restricted plan.
   */
  private async resolveDefaultPlan(requestedTier?: PlanTier): Promise<SubscriptionPlan> {
    const restricted: PlanTier[] = [PlanTier.UNLIMITED, PlanTier.CUSTOM];

    if (requestedTier) {
      if (restricted.includes(requestedTier)) {
        throw new BadRequestException(
          `El plan "${requestedTier}" solo puede ser asignado por un administrador.`,
        );
      }
      const requested = await this.planRepo.findOne({
        where: { tier: requestedTier, isActive: true },
      });
      if (requested) return requested;
      // Fall through to default if requested tier exists in enum but no active row
    }

    const basic = await this.planRepo.findOne({
      where: { tier: PlanTier.BASIC, isActive: true },
    });
    if (basic) return basic;

    const fallback = await this.planRepo.findOne({
      where: {
        isActive: true,
        tier: Not(In(restricted)),
      },
      order: { monthlyPrice: 'ASC' },
    });
    if (!fallback) {
      throw new BadRequestException(
        'No hay planes disponibles para registrar la cuenta. Contacte soporte.',
      );
    }
    return fallback;
  }

  private async notifySuperadmins(account: Account, adminName: string, trialEndsAt: Date) {
    const admins = await this.adminRepo.find({ where: { isActive: true } });
    const emails = admins.map((a) => a.email).filter(Boolean);
    if (emails.length === 0) return;

    await this.notificationService.sendNewTrialRegistration(emails, {
      accountName: account.name,
      accountRuc: account.ruc,
      accountEmail: account.email,
      adminName,
      trialEndsAt: trialEndsAt.toISOString().split('T')[0],
    });
  }

  private buildResetUrl(token: string): string {
    const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:8080');
    return `${frontendUrl}/reset-password?token=${token}`;
  }
}
