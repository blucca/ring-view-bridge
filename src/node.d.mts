export class RingError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status?: number);
  toJSON(): {code: string; message: string; status: number};
}
export interface WhepTransport {
  startLiveSession(deviceId: string, offer: string): Promise<{answer: string; sessionUrl: string}>;
  closeLiveSession(deviceId: string, sessionUrl: string): Promise<unknown>;
}
export class RingWhepClient implements WhepTransport {
  constructor(options?: {
    accessToken?: string;
    getAccessToken?: () => string | Promise<string>;
    baseUrl?: string;
    timeoutMs?: number;
  });
  startLiveSession(deviceId: string, offer: string): Promise<{answer: string; sessionUrl: string}>;
  closeLiveSession(deviceId: string, sessionUrl: string): Promise<{closed: true}>;
}
export interface SessionInfo {
  sessionId: string;
  deviceId: string;
  startedAt: string;
  expiresAt: string;
  maxSeconds: number;
}
export interface SessionEvent extends SessionInfo {
  type: 'started' | 'closed' | 'close_failed';
  reason?: string;
  closedAt?: string;
  error?: {code: string; message: string};
}
export class LiveSessionPool {
  constructor(options: {
    client: WhepTransport;
    maxSessions?: number;
    lifetimeMs?: number;
    onEvent?: (event: SessionEvent) => unknown;
  });
  readonly activeCount: number;
  readonly closing: boolean;
  has(sessionId: string): boolean;
  get(sessionId: string): SessionInfo | null;
  open(options: {deviceId: string; offer: string}): Promise<SessionInfo & {answer: string}>;
  close(sessionId: string, reason?: string): Promise<{closed: true; sessionId: string}>;
  closeAll(reason?: string): Promise<{closed: boolean; failedSessionIds: string[]}>;
}
export function assertSameOrigin(
  request: {headers: Record<string, string | string[] | undefined>},
  expectedOrigin: string,
): void;
