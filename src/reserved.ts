import type { Principal } from "./types";

/**
 * Names an ordinary account may never claim.
 *
 * A temporary address is exactly the surface impersonation uses: `support@` that
 * is not support, `admin@` that is not the operator, `postmaster@` that nobody
 * monitors. They are grouped by what they imitate, and the group label is what
 * the refusal message quotes back.
 *
 * Celestial (the owner principal) may still claim any of them, so the operator can
 * hold the canonical addresses mail standards and providers expect to exist
 * (postmaster@, abuse@, security@) instead of having them permanently unreachable.
 */
export const RESERVED: Readonly<Record<string, readonly string[]>> = {
  // Claims of ownership, rank or official standing.
  authority: [
    "admin",
    "administrator",
    "superadmin",
    "root",
    "owner",
    "founder",
    "ceo",
    "cto",
    "director",
    "manager",
    "mod",
    "moderator",
    "staff",
    "official",
    "team",
    "management",
  ],
  // Names a victim would trust with data, money or a password.
  support: [
    "support",
    "help",
    "helpdesk",
    "cs",
    "customerservice",
    "service",
    "info",
    "contact",
    "faq",
    "ask",
    "care",
    "billing",
    "finance",
    "payment",
    "refund",
    "security",
    "abuse",
    "trust",
    "safety",
    "legal",
    "privacy",
  ],
  // Names the mail system itself, or an automated sender, already uses.
  system: [
    "dev",
    "developer",
    "sysadmin",
    "system",
    "sys",
    "bot",
    "api",
    "server",
    "localhost",
    "host",
    "master",
    "webmaster",
    "postmaster",
    "hostmaster",
    "noreply",
    "no-reply",
    "mailer",
    "mailer-daemon",
    "daemon",
    "cron",
    "status",
    "maintenance",
    "test",
    "testing",
    "staging",
    "beta",
    "alpha",
    "debug",
    "null",
    "undefined",
    "void",
    "anonymous",
    "guest",
    "user",
    "member",
  ],
};

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  authority: "nama otoritas atau manajemen",
  support: "nama layanan atau bantuan resmi",
  system: "nama teknis atau sistem",
};

const INDEX: ReadonlyMap<string, string> = new Map(
  Object.entries(RESERVED).flatMap(([category, names]) =>
    names.map((name) => [name, category] as const),
  ),
);

/** The category a name belongs to, or null when it is free for anyone. */
export function reservedCategory(name: string): string | null {
  return INDEX.get(name.toLowerCase()) ?? null;
}

/**
 * Celestial is the only principal that may claim a reserved name. Both the owner
 * principal id and the owner role are checked: a member account can hold the
 * owner role, and the address namespace is shared.
 */
export function canClaimReserved(user: Principal): boolean {
  return user.id === "owner" || user.roles.includes("owner");
}

/** The refusal message, naming the group the name imitates. */
export function reservedMessage(name: string): string {
  const category = reservedCategory(name) ?? "system";
  return `"${name}" diamankan sebagai ${CATEGORY_LABEL[category] ?? "nama internal"} dan hanya Celestial yang dapat memakainya.`;
}