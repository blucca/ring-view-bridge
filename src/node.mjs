import {randomUUID} from 'node:crypto';

const MAX_SDP_BYTES = 96 * 1024;
const DEFAULT_ORIGIN = 'https://api.amazonvision.com';
// Failed startup cleanup crosses the client/pool boundary without exposing a URL on the error.
const pendingStartCleanup = new WeakMap();

export class RingError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'RingError';
    this.code = code;
    this.status = status;
  }
  toJSON() { return {code: this.code, message: this.message, status: this.status}; }
}

function invalidResponse() {
  return new RingError('ring_invalid_response', 'Ring returned an incomplete or invalid streaming response.');
}

function devicePath(deviceId) {
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 512) {
    throw new RingError('ring_device_required', 'Select a Ring device on the server.', 400);
  }
  return `/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`;
}

function parseOrigin(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch {
    throw new RingError('ring_configuration', 'Set a valid Ring API origin.', 500);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new RingError('ring_configuration', 'Use an HTTPS Ring API origin or a loopback HTTP test server.', 500);
  }
  return url;
}

async function readSdp(response) {
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SDP_BYTES) { await reader.cancel(); throw invalidResponse(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const answer = Buffer.concat(chunks).toString('utf8');
  if (!answer.startsWith('v=0') || !answer.includes('m=video ')) throw invalidResponse();
  return answer;
}

/** Server-only WHEP exchange. Session URLs and bearer tokens stay on this side. */
export class RingWhepClient {
  #getAccessToken;
  #baseUrl;
  #timeoutMs;

  constructor({accessToken, getAccessToken, baseUrl = DEFAULT_ORIGIN, timeoutMs = 8000} = {}) {
    this.#baseUrl = parseOrigin(baseUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new RingError('ring_configuration', 'Set timeoutMs between 1 and 30000.', 500);
    }
    if (getAccessToken !== undefined && typeof getAccessToken !== 'function') {
      throw new RingError('ring_configuration', 'Provide a getAccessToken function.', 500);
    }
    if (!getAccessToken && (typeof accessToken !== 'string' || !accessToken.trim())) {
      throw new RingError('ring_unconfigured', 'Provide a server-side Ring access token.', 503);
    }
    this.#getAccessToken = getAccessToken || (() => accessToken);
    this.#timeoutMs = timeoutMs;
  }

  #sessionUrl(deviceId, location) {
    if (typeof location !== 'string' || !location) throw invalidResponse();
    let url;
    try { url = new URL(location, this.#baseUrl); } catch { throw invalidResponse(); }
    const prefix = `${devicePath(deviceId)}/`;
    if (url.origin !== this.#baseUrl.origin || url.username || url.password || url.hash
      || !url.pathname.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(url.pathname.slice(prefix.length))) {
      throw invalidResponse();
    }
    return url;
  }

  async #request(url, method, offer) {
    let token;
    try { token = await this.#getAccessToken(); } catch {
      throw new RingError('ring_unconfigured', 'Reading the server-side Ring token failed.', 503);
    }
    if (typeof token !== 'string' || !token.trim()) {
      throw new RingError('ring_unconfigured', 'Provide a fresh server-side Ring access token.', 503);
    }
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await fetch(url, {
        method, redirect: 'error', signal,
        headers: {Authorization: `Bearer ${token.trim()}`,
          ...(method === 'POST' ? {'Content-Type': 'application/sdp', Accept: 'application/sdp'} : {})},
        ...(offer === undefined ? {} : {body: offer}),
      });
      if (!response.ok && !(method === 'DELETE' && [404, 410].includes(response.status))) {
        await response.body?.cancel();
        const status = response.status;
        const code = [401, 403].includes(status) ? 'ring_auth'
          : status === 429 ? 'ring_rate_limited' : 'ring_stream_http';
        throw new RingError(code, `Ring live-view request failed (HTTP ${status}). Check token and device access.`, status);
      }
      if (method === 'DELETE') { await response.body?.cancel(); return {closed: true}; }
      return {response, signal};
    } catch (error) {
      if (error instanceof RingError) throw error;
      if (signal.aborted) throw new RingError('ring_timeout', 'The Ring live-view request timed out.', 504);
      throw new RingError('ring_network', 'The Ring live-view connection failed. Check backend connectivity.', 502);
    }
  }

  async startLiveSession(deviceId, offer) {
    const path = devicePath(deviceId);
    if (typeof offer !== 'string' || !offer.startsWith('v=0') || !offer.includes('m=video ')
      || Buffer.byteLength(offer) > MAX_SDP_BYTES) {
      throw new RingError('ring_invalid_offer', 'Provide a browser-generated video SDP offer within 96 KiB.', 400);
    }
    const {response, signal} = await this.#request(new URL(path, this.#baseUrl), 'POST', offer);
    let sessionUrl;
    try {
      if (response.status !== 201) throw invalidResponse();
      sessionUrl = this.#sessionUrl(deviceId, response.headers.get('location')).toString();
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/sdp') {
        throw invalidResponse();
      }
      return {answer: await readSdp(response), sessionUrl};
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      const failure = signal.aborted
        ? new RingError('ring_timeout', 'Reading the Ring SDP answer timed out.', 504)
        : error instanceof RingError ? error : invalidResponse();
      // A valid Location still gets released when the SDP body fails validation.
      if (sessionUrl) {
        try { await this.closeLiveSession(deviceId, sessionUrl); } catch (cleanupError) {
          pendingStartCleanup.set(failure, {client: this, deviceId, sessionUrl,
            code: cleanupError.code || 'ring_network'});
        }
      }
      throw failure;
    }
  }

  async closeLiveSession(deviceId, sessionUrl) {
    return this.#request(this.#sessionUrl(deviceId, sessionUrl), 'DELETE');
  }
}

/** Bounded in-memory lifecycle, including creates and deletes in flight. */
export class LiveSessionPool {
  #client;
  #sessions = new Map();
  #maxSessions;
  #lifetimeMs;
  #onEvent;
  #closing = false;

  constructor({client, maxSessions = 2, lifetimeMs = 60_000, onEvent} = {}) {
    if (!client || typeof client.startLiveSession !== 'function' || typeof client.closeLiveSession !== 'function') {
      throw new TypeError('Provide a RingWhepClient-compatible client.');
    }
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100
      || !Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 300_000) {
      throw new TypeError('Use 1–100 sessions and a lifetime of 1–300000 milliseconds.');
    }
    if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Provide an onEvent function.');
    this.#client = client;
    this.#maxSessions = maxSessions;
    this.#lifetimeMs = lifetimeMs;
    this.#onEvent = onEvent;
  }

  get activeCount() { return this.#sessions.size; }
  get closing() { return this.#closing; }
  has(sessionId) {
    const entry = this.#sessions.get(sessionId);
    return Boolean(entry?.public && !entry.closeReason);
  }
  get(sessionId) {
    const entry = this.#sessions.get(sessionId);
    return entry?.public ? {...entry.public} : null;
  }
  #emit(type, entry, fields = {}) {
    try {
      const result = this.#onEvent?.({type, ...entry.public, sessionId: entry.sessionId, deviceId: entry.deviceId, ...fields});
      Promise.resolve(result).catch(() => {});
    } catch { /* Observers leave session cleanup in control of the pool. */ }
  }

  async open({deviceId, offer} = {}) {
    if (this.#closing) throw new RingError('ring_pool_closing', 'The session pool is stopping.', 503);
    if (this.activeCount >= this.#maxSessions) {
      throw new RingError('ring_session_limit', 'Close an active view before opening another stream.', 429);
    }
    const sessionId = randomUUID();
    const entry = {sessionId, deviceId, public: null, upstream: null, timer: null, closeReason: null, closePromise: null};
    this.#sessions.set(sessionId, entry);
    entry.ready = Promise.resolve().then(() => this.#client.startLiveSession(deviceId, offer));
    try {
      const result = await entry.ready;
      entry.upstream = result.sessionUrl;
      const now = Date.now();
      entry.public = Object.freeze({sessionId, deviceId, startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.#lifetimeMs).toISOString(), maxSeconds: this.#lifetimeMs / 1000});
      this.#emit('started', entry);
      if (entry.closeReason || this.#closing) {
        await this.close(sessionId, entry.closeReason || 'server_shutdown');
        throw new RingError('ring_session_ended', 'The view was closed during startup.', 409);
      }
      entry.timer = setTimeout(() => { void this.close(sessionId, 'duration_limit').catch(() => {}); }, this.#lifetimeMs);
      entry.timer.unref?.();
      return {...entry.public, answer: result.answer};
    } catch (error) {
      const cleanup = pendingStartCleanup.get(error);
      if (cleanup?.client === this.#client && cleanup.deviceId === deviceId) {
        pendingStartCleanup.delete(error);
        entry.upstream = cleanup.sessionUrl;
        entry.ready = Promise.resolve({sessionUrl: cleanup.sessionUrl});
        entry.closeReason ||= 'startup_failed';
        const now = Date.now();
        entry.public = Object.freeze({sessionId, deviceId, startedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.#lifetimeMs).toISOString(), maxSeconds: this.#lifetimeMs / 1000});
        this.#emit('close_failed', entry, {reason: entry.closeReason,
          error: {code: cleanup.code, message: 'Upstream session cleanup failed. Retry close().'}});
      } else if (!entry.upstream) this.#sessions.delete(sessionId);
      throw error;
    }
  }

  close(sessionId, reason = 'viewer_closed') {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return Promise.resolve({closed: true, sessionId});
    if (entry.closePromise) return entry.closePromise;
    entry.closeReason ||= reason;
    entry.closePromise = (async () => {
      let result;
      try { result = await entry.ready; } catch {
        // open() restores a known upstream before this older ready rejection resumes.
        if (!entry.upstream) {
          this.#sessions.delete(sessionId);
          return {closed: true, sessionId};
        }
      }
      entry.upstream ||= result.sessionUrl;
      clearTimeout(entry.timer);
      try {
        await this.#client.closeLiveSession(entry.deviceId, entry.upstream);
        this.#sessions.delete(sessionId);
        const closedAt = new Date().toISOString();
        this.#emit('closed', entry, {reason: entry.closeReason, closedAt});
        return {closed: true, sessionId};
      } catch (error) {
        entry.closePromise = null;
        this.#emit('close_failed', entry, {reason: entry.closeReason,
          error: {code: error.code || 'ring_network', message: 'Upstream session cleanup failed. Retry close().'}});
        // Keep the slot reserved until a successful explicit retry or shutdown.
        throw error;
      }
    })();
    return entry.closePromise;
  }

  async closeAll(reason = 'server_shutdown') {
    this.#closing = true;
    const entries = [...this.#sessions.keys()];
    const results = await Promise.allSettled(entries.map(id => this.close(id, reason)));
    const failedSessionIds = entries.filter((_, i) => results[i].status === 'rejected');
    return {closed: failedSessionIds.length === 0, failedSessionIds};
  }
}

/** Apply before reading a browser mutation. Configure the trusted app origin. */
export function assertSameOrigin(request, expectedOrigin) {
  const expected = new URL(expectedOrigin).origin;
  if (request.headers.origin && request.headers.origin !== expected) {
    throw new RingError('origin', 'Use the configured app origin for this action.', 403);
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new RingError('origin', 'Use the configured app origin for this action.', 403);
  }
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RingError('content_type', 'Send application/json.', 415);
  }
}
