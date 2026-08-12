// Error coercion helpers — single home for catch-block message extraction.
// See .dev-vault/toc.md for the module table of contents.

// Coerces an unknown caught value into a human-readable message string.
// Mirrors the `e.message` pattern that previously forced `catch (e: any)`.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
