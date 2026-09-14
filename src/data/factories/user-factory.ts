export function uniqueEmail(prefix = "auto"): string {
  return `${prefix}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.test`;
}
