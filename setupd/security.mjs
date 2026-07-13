import crypto from "node:crypto";

const GENERIC_SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /("?(?:token|api[_-]?key|password|secret)"?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
  /(--(?:gateway-token|token|api-key|password)\s+)[^\s]+/gi,
];

export function makeSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

export function createSanitizer(secrets = []) {
  const known = [...secrets].filter((value) => typeof value === "string" && value.length >= 4);

  return (input) => {
    let output = String(input ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "[REDACTED_QR_IMAGE]")
      .slice(0, 8_000);

    for (const value of known) {
      output = output.replaceAll(value, "[REDACTED]");
    }

    output = output
      .replace(GENERIC_SECRET_PATTERNS[0], "[REDACTED]")
      .replace(GENERIC_SECRET_PATTERNS[1], "[REDACTED]")
      .replace(GENERIC_SECRET_PATTERNS[2], "$1[REDACTED]")
      .replace(GENERIC_SECRET_PATTERNS[3], "$1[REDACTED]")
      .replace(GENERIC_SECRET_PATTERNS[4], "$1[REDACTED]");

    return output;
  };
}

export function publicState(state) {
  const clone = structuredClone(state);
  delete clone.secrets;
  return clone;
}
