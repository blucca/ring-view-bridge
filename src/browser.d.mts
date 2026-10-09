export type RingViewerState = 'idle' | 'connecting' | 'waiting' | 'playing' | 'interrupted' | 'ended' | 'error';

/** Supply expiresAt, a positive maxSeconds, or both to bound the view. Times use ISO 8601. */
export interface RingViewerSession {
  sessionId: string;
  answer: string;
  startedAt?: string;
  expiresAt?: string;
  maxSeconds?: number;
}

export interface RingViewerStateEvent<Session extends RingViewerSession = RingViewerSession> {
  state: RingViewerState;
  reason?: string;
  error?: unknown;
  /** The affected session, including an older generation's delayed release failure. */
  session?: Session;
}

export interface RingFirstFrameEvent<Session extends RingViewerSession = RingViewerSession> {
  session: Session;
  observedAt: string;
  source: 'video-frame-callback' | 'loadeddata' | 'playing' | 'ready-state';
}

export interface RingViewerOptions<Session extends RingViewerSession = RingViewerSession> {
  video: HTMLVideoElement;
  createSession(input: {offer: string; signal: AbortSignal}): Session | PromiseLike<Session>;
  releaseSession(sessionId: string, reason: string): unknown | PromiseLike<unknown>;
  onStateChange?(event: RingViewerStateEvent<Session>): void | PromiseLike<void>;
  onFirstFrame?(event: RingFirstFrameEvent<Session>): void | PromiseLike<void>;
  rtcConfiguration?: RTCConfiguration;
  /** Default: 8000 ms. Send collected ICE candidates when this duration elapses. */
  iceGatheringTimeoutMs?: number;
  /** Default: 25000 ms. Passed through an AbortSignal to createSession. */
  requestTimeoutMs?: number;
  /** Default: 20000 ms after applying the remote description. */
  firstFrameTimeoutMs?: number;
}

export interface RingViewer<Session extends RingViewerSession = RingViewerSession> {
  /** Resolves after SDP negotiation; close resolves the in-flight start with null. Setup failures reject. */
  start(): Promise<Session | null>;
  /** Releases local media immediately and waits for session release, including late creates. */
  close(reason?: string): Promise<void>;
  readonly state: RingViewerState;
  /** The current generation's session. Becomes null when that generation closes. */
  readonly session: Session | null;
}

export function createRingViewer<Session extends RingViewerSession = RingViewerSession>(
  options: RingViewerOptions<Session>,
): RingViewer<Session>;
