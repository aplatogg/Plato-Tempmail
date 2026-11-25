export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_NAME?: string;
  PUBLIC_ORIGIN: string;
  MAIL_DOMAIN: string;
  ADMIN_USERNAME: string;
  MESSAGE_RETENTION_DAYS: string;
  MAX_TOTAL_INBOXES?: string;
  MAX_MEMBER_ACCOUNTS?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  AUTH_PASSWORD_HASH?: string;
  RESET_EMAIL?: SendEmail;
  RESET_EMAIL_TO?: string;
}

export interface AppConfig {
  origin: string;
  secure: boolean;
  username: string;
  mailDomain: string;
  retentionDays: number;
  maxInboxes: number;
  maxMembers: number;
}

export interface AuthConfig {
  verifier: string;
  bootstrapFingerprint: string;
  revision: number;
  salt: Uint8Array<ArrayBuffer>;
  digest: Uint8Array<ArrayBuffer>;
  credentialVersion: string;
  roleMask: number;
}

export type Role = "member" | "dev" | "admin" | "owner" | "peasant" | "member_paid";
export type Principal = { id: string; username: string; role: "owner" | "user"; roles: Role[] };

export interface AppBindings {
  Bindings: Env;
  Variables: {
    config: AppConfig;
    auth: AuthConfig;
    sessionHash: string;
    user: Principal;
    apiKey?: string;
  };
}
