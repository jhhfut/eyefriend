const BACKEND_URL = (import.meta as any).env?.VITE_BACKEND_URL || 'http://localhost:8080';

export interface Session {
  id: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
  status: 'active' | 'ended';
  alertsCount: number;
  textReadCount: number;
}

export interface Analytics {
  totalSessions: number;
  completedSessions: number;
  totalAlerts: number;
  totalTextReads: number;
  modeDistribution: { mode: string; count: number }[];
}

async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    console.error(`[sessionService] ${path} failed:`, err);
    return null;
  }
}

export async function createSession(mode: string = 'default'): Promise<string | null> {
  const data = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
  return data?.id ?? null;
}

export async function endSession(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'ended' }),
  });
}

export async function logAlert(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ incrementAlert: true }),
  });
}

export async function logTextRead(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ incrementTextRead: true }),
  });
}

export async function getSessions(): Promise<Session[]> {
  const data = await apiFetch('/api/sessions');
  return data ?? [];
}

export async function getAnalytics(): Promise<Analytics | null> {
  return apiFetch('/api/analytics');
}

export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
}
