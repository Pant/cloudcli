export function createDiagnosticId(): string {
  try { return globalThis.crypto?.randomUUID?.() ?? `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  catch { return `diag-${Date.now().toString(36)}`; }
}
