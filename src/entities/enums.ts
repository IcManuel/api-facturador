export enum AccountType {
  SINGLE = 'single',
  MULTI = 'multi',
}

export enum AccountStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  BLOCKED = 'blocked',
}

export enum AccountUserRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

export enum PlanTier {
  BASIC = 'basic',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
  UNLIMITED = 'unlimited',
  PAYPERUSE = 'payperuse',
}

export enum CompanyEnv {
  PRODUCTION = 'production',
  TEST = 'test',
}

export enum CompanyStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export enum SriDocTypeCode {
  FACTURA = '01',
  LIQUIDACION_COMPRAS = '03',
  NOTA_CREDITO = '04',
  NOTA_DEBITO = '05',
  GUIA_REMISION = '06',
  RETENCION = '07',
}

export enum DocStatus {
  CREATED = 'CREATED',
  PROCESSING = 'PROCESSING',
  RECEIVED = 'RECEIVED',
  AUTHORIZED = 'AUTHORIZED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export enum TimelineStepStatus {
  COMPLETED = 'completed',
  CURRENT = 'current',
  PENDING = 'pending',
  ERROR = 'error',
}

export enum SriErrorCategory {
  CLIENT = 'client',
  SYSTEM = 'system',
}

export enum SriErrorSeverity {
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export enum DocFileType {
  SIGNED_XML = 'signed_xml',
  AUTHORIZED_XML = 'authorized_xml',
  PDF = 'pdf',
  RIDE = 'ride',
}

export enum BillingStatus {
  PAID = 'paid',
  PENDING = 'pending',
  PARTIAL = 'partial',
  OVERDUE = 'overdue',
}

export enum PaymentMethod {
  TRANSFER = 'transfer',
  CASH = 'cash',
  CARD = 'card',
  OTHER = 'other',
  PAGOPLUX = 'pagoplux',
}

export enum LogType {
  WEBHOOK = 'webhook',
  SRI = 'sri',
  WORKER = 'worker',
}

export enum LogLevel {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
}

export enum NotificationPriority {
  URGENT = 'urgent',
  INFO = 'info',
}

export enum AccessKeyMode {
  PLATFORM = 'platform',
  CLIENT = 'client',
}

export enum SequentialMode {
  PLATFORM = 'platform',
  CLIENT = 'client',
}
