/**
 * Utility to detect and handle agent offline errors
 */

/**
 * Check if an error indicates the agent is offline
 * @param error - Error to check
 * @returns True if error indicates agent is offline
 */
export function isAgentOfflineError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("agent is offline") ||
      message.includes("agent offline") ||
      message.includes("refresh agent connection") ||
      message.includes("failed to connect to agent") ||
      message.includes("agent request timeout") ||
      message.includes("agent api returned status")
    );
  }
  return false;
}

/**
 * Check if a response status indicates agent is offline
 * @param status - HTTP status code
 * @param errorMessage - Optional error message
 * @returns True if status/message indicates agent is offline
 */
export function isAgentOfflineResponse(
  status: number,
  errorMessage?: string,
): boolean {
  // 503 status code is always considered agent offline (from our backend)
  if (status === 503) {
    return true;
  }

  // For other status codes, check error message
  if (errorMessage) {
    const message = errorMessage.toLowerCase();
    const isAgentError =
      message.includes("agent is offline") ||
      message.includes("agent offline") ||
      message.includes("refresh agent connection") ||
      message.includes("failed to connect to agent") ||
      message.includes("agent request timeout") ||
      message.includes("agent api returned status");

    // 400, 500 with agent error message also indicates agent issue
    if ((status === 400 || status === 500) && isAgentError) {
      return true;
    }
  }
  return false;
}

/**
 * Extract error message from fetch response
 */
export async function extractResponseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.message || data.error || res.statusText;
  } catch {
    return res.statusText;
  }
}
