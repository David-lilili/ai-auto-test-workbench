const SECRET_PATTERN = /(authorization|token|cookie|password|secret|api[-_]?key)/i;

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_PATTERN.test(key) ? "***" : maskSecrets(item)
      ])
    );
  }
  if (typeof value === "string" && value.length > 20 && /bearer|sk-|eyJ/i.test(value)) {
    return "***";
  }
  return value;
}
