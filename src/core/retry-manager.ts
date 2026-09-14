export async function withRetry<T>(
  action: () => Promise<T>,
  retries: number,
  onRetry?: (attempt: number, error: unknown) => void
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < retries) onRetry?.(attempt + 1, error);
    }
  }
  throw lastError;
}
