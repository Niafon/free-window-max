import { initData } from './bridge';
export class ApiError extends Error { constructor(message: string, public code: string, public status: number) { super(message); } }
async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const raw = initData();
  const response = await fetch('/api/v1' + path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'X-Max-Init-Data': raw } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(value.error?.message ?? 'Нет соединения. Попробуйте ещё раз', value.error?.code ?? 'NETWORK_ERROR', response.status);
  return value;
}
// Outside MAX the service opens straight away: a guest session is created silently on the first 401 and the call is repeated.
let guest: Promise<unknown> | null = null;
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  try { return await request<T>(path, method, body); } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401 || initData() || path.startsWith('/auth/')) throw e;
    guest ??= request('/auth/guest', 'POST', {}).finally(() => { guest = null; });
    await guest; return request<T>(path, method, body);
  }
}
