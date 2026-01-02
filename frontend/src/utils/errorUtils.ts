/**
 * Error utility functions for consistent error handling
 */

/**
 * Custom error class that preserves HTTP status code
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Extract error message from unknown error type
 * @param error - Error of unknown type
 * @param fallback - Fallback message if error message cannot be extracted
 * @returns Error message string
 */
export function getErrorMessage(
  error: unknown,
  fallback: string = "Unknown error",
): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  return fallback;
}

/**
 * Check if an error is an authentication error (401 Unauthorized)
 * @param error - Error of unknown type
 * @returns true if the error appears to be a 401 authentication error
 */
export function isAuthError(error: unknown): boolean {
  // Check if it's an ApiError with status 401
  if (error instanceof ApiError && error.status === 401) {
    return true;
  }

  // Check error message patterns
  const errorMessage = getErrorMessage(error, "").toLowerCase();
  return (
    errorMessage.includes("401") ||
    errorMessage.includes("unauthorized") ||
    errorMessage.includes("not authenticated") ||
    errorMessage.includes("authentication required") ||
    errorMessage.includes("invalid token") ||
    errorMessage.includes("token expired") ||
    errorMessage.includes("session expired") ||
    errorMessage.includes("session has been revoked") ||
    errorMessage.includes("session invalid") ||
    errorMessage.includes("please login again") ||
    errorMessage.includes("no token provided") ||
    errorMessage.includes("session revoked")
  );
}
