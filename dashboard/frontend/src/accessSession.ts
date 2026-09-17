import { createContext, useContext } from 'react';

export interface AccessUser {
  id: string;
  kind: 'guest' | 'account';
  username: string | null;
  expires_at: string;
}
export interface AccessSession {
  mode: 'local' | 'hosted';
  user: AccessUser | null;
  limits: { max_video_seconds: number; max_upload_mb: number; guest_generations_remaining?: number };
}
export interface AccessContextValue {
  session: AccessSession;
  busy: boolean;
  openAccess: (mode: 'login' | 'register' | 'logout') => void;
  refresh: () => Promise<void>;
}
export const AccessSessionContext = createContext<AccessContextValue>({
  session: { mode: 'local', user: null, limits: { max_video_seconds: 600, max_upload_mb: 500 } },
  busy: false,
  openAccess: () => {},
  refresh: async () => {},
});
export const useAccessSession = () => useContext(AccessSessionContext);

export async function accessRequest(path = '/session', payload?: Record<string, string>): Promise<AccessSession> {
  const response = await fetch('/api/access' + path, {
    method: payload ? 'POST' : 'GET',
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : typeof body?.detail === 'string' ? body.detail : 'Unable to access the workspace. Please try again.');
  if (!body || !['local', 'hosted'].includes(body.mode) || !body.limits || !('user' in body) || (body.user !== null && (typeof body.user.id !== 'string' || !['guest', 'account'].includes(body.user.kind)))) {
    throw new Error('The service returned an invalid workspace session.');
  }
  return body as AccessSession;
}
