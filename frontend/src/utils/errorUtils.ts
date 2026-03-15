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
    public data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown, fallback = 'An error occurred'): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return fallback;
}

/**
 * Extract error message from XMLHttpRequest response
 * @param xhr - XMLHttpRequest object
 * @returns Error message string
 */
const UPLOAD_FAILED_PREFIX = 'Upload failed: ';

export function extractXhrErrorMessage(xhr: XMLHttpRequest): string {
  let errorMessage = `${UPLOAD_FAILED_PREFIX}${xhr.statusText}`;

  try {
    const responseText = xhr.responseText;
    if (responseText && responseText.trim().length > 0) {
      try {
        const errorData = JSON.parse(responseText);
        const bodyMessage = errorData.message || errorData.error || errorData.msg;
        if (bodyMessage && typeof bodyMessage === 'string') {
          errorMessage = bodyMessage;
        }
      } catch {
        if (responseText.length < 500) {
          errorMessage = responseText.trim() || errorMessage;
        }
      }
    }
  } catch {
    // Use status-specific defaults when parsing fails
    if (xhr.status === 413) {
      errorMessage = 'File too large or storage limit exceeded.';
    } else if (xhr.status === 400) {
      errorMessage = 'Invalid file or request.';
    } else if (xhr.status >= 500) {
      errorMessage = 'Server error. Please try again later.';
    }
  }

  // For 413, never show raw status text; use a clear storage-limit message if we have no body message
  if (xhr.status === 413 && (errorMessage.startsWith(UPLOAD_FAILED_PREFIX) || !errorMessage.trim())) {
    errorMessage = 'File too large or storage limit exceeded.';
  }

  return errorMessage;
}

/**
 * Extract error message from fetch Response
 */
export async function extractResponseError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text || text.trim().length === 0) {
      return `${res.statusText} (empty response body)`;
    }
    try {
      const data = JSON.parse(text);
      return data.message || data.error || res.statusText;
    } catch {
      return text.length < 500 ? text.trim() : `${res.statusText} (non-JSON response)`;
    }
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
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
    return error.message.includes('401') || error.message.toLowerCase().includes('unauthorized');
  }
  return false;
}
