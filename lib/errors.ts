export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        'error_message' in data &&
        typeof data.error_message === 'string'
      ) {
        return data.error_message;
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}
