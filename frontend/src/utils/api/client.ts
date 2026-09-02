/**
 * Shared HTTP client for the JSON API. Every domain module builds on these
 * verbs; nothing here is feature-specific.
 */
import { ApiError } from '../errorUtils';

export interface ApiRequestOptions extends RequestInit {
  signal?: AbortSignal;
}

async function apiRequest(endpoint: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { headers: customHeaders, ...restOptions } = options;

  const defaultOptions: RequestInit = {
    credentials: 'include',
    ...restOptions,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...customHeaders,
    },
  };

  return fetch(endpoint, defaultOptions);
}

interface ErrorResponseBody {
  message?: string;
  error?: string;
  [key: string]: unknown;
}

function isErrorResponseBody(data: unknown): data is ErrorResponseBody {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

async function throwApiErrorWithDetails(res: Response): Promise<never> {
  const raw = await res.json().catch(() => null);
  const errorData: ErrorResponseBody = isErrorResponseBody(raw) ? raw : { message: res.statusText };
  const { message, error, ...rest } = errorData;
  const errorMessage =
    (typeof message === 'string' && message) || (typeof error === 'string' && error) || res.statusText;
  throw new ApiError(errorMessage, res.status, Object.keys(rest).length > 0 ? rest : undefined);
}

export async function apiGet<T = unknown>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, { method: 'GET', ...options });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function apiPost<T = unknown>(endpoint: string, data?: unknown, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
    ...options,
  });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function apiPut<T = unknown>(endpoint: string, data?: unknown, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: 'PUT',
    body: data ? JSON.stringify(data) : undefined,
    ...options,
  });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function apiPostForm<T = unknown>(endpoint: string, formData: FormData): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: 'POST',
    body: formData,
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function apiDelete<T = unknown>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, { method: 'DELETE', ...options });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}
