/** Removes provider-added line-count metadata without altering path punctuation. */
export function sanitizeFileReference(value: string): string {
  return value.trim().replace(/\s+\(\d+\s+lines?\)\s*:?\s*$/, '').trim();
}
