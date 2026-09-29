import { initData } from './bridge';
export class ApiError extends Error { constructor(message: string, public code: string, public status: number) { super(message); } }
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const raw = initData();
  const response = await fetch('/api/v1' + path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'X-Max-Init-Data': raw } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error?.message ?? 'Не удалось выполнить запрос', value.error?.code ?? 'NETWORK_ERROR', response.status);
  return value;
}
