/**
 * Error utility functions for consistent error handling
 */

/**
 * Custom error class that preserves HTTP status code and additional error data
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: Record<string, unknown>,
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
export function extractErrorMessage(
  error: unknown,
  fallback = "An error occurred",
): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return fallback;
}

/**
 * Extract error message from XMLHttpRequest response
 * @param xhr - XMLHttpRequest object
 * @returns Error message string
 */
export function extractXhrErrorMessage(xhr: XMLHttpRequest): string {
  let errorMessage = `Upload failed: ${xhr.statusText}`;

  try {
    const responseText = xhr.responseText;
    if (responseText && responseText.trim().length > 0) {
      try {
        const errorData = JSON.parse(responseText);
        // Try multiple possible error message fields
        errorMessage =
          errorData.message || errorData.error || errorData.msg || errorMessage;
      } catch {
        // If JSON parsing fails, use responseText if it's short enough
        if (responseText.length < 500) {
          errorMessage = responseText;
        }
      }
    }
  } catch {
    // If all parsing fails, use status-specific defaults
    if (xhr.status === 413) {
      errorMessage = "File too large or storage limit exceeded";
    } else if (xhr.status === 400) {
      errorMessage = "Invalid file or request";
    } else if (xhr.status >= 500) {
      errorMessage = "Server error. Please try again later.";
    }
  }

  return errorMessage;
}

/**
 * Get error message from unknown error type (alias for extractErrorMessage for backward compatibility)
 * @param error - Error of unknown type
 * @param fallback - Fallback message if error message cannot be extracted
 * @returns Error message string
 */
export function getErrorMessage(
  error: unknown,
  fallback = "An error occurred",
): string {
  return extractErrorMessage(error, fallback);
}

/**
 * Check if error is an authentication error (401)
 * @param error - Error to check
 * @returns True if error is an authentication error
 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401;
  }
  if (error instanceof Error) {
    return (
      error.message.includes("401") ||
      error.message.toLowerCase().includes("unauthorized")
    );
  }
  return false;
}
