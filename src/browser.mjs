const DEFAULT_RTC_CONFIGURATION = {
  iceServers: [{urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}],
};

function errorWithCode(message, code) {
  return Object.assign(new Error(message), {code});
}

function waitForIce(peer, signal, timeoutMs) {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const aborted = () => finish(signal.reason);
    // At the gathering deadline, send the candidates collected so far.
    const timer = setTimeout(() => finish(), timeoutMs);
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', aborted, {once: true});
  });
}

function waitForSession(promise, controller, timeoutMs) {
  const {signal} = controller;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = (handler, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      handler(value);
    };
    const aborted = () => finish(reject, signal.reason);
    const timer = setTimeout(() => {
      controller.abort(errorWithCode('The session request exceeded its deadline.', 'request_timeout'));
    }, timeoutMs);
    signal.addEventListener('abort', aborted, {once: true});
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function remainingLifetime(session, receivedAt) {
  const deadlines = [];
  const expiresAt = Date.parse(session.expiresAt);
  const startedAt = Date.parse(session.startedAt);
  if (Number.isFinite(expiresAt)) deadlines.push(expiresAt);
  if (Number.isFinite(session.maxSeconds) && session.maxSeconds > 0) {
    deadlines.push(receivedAt + session.maxSeconds * 1000);
    if (Number.isFinite(startedAt)) deadlines.push(startedAt + session.maxSeconds * 1000);
  }
  if (!deadlines.length) {
    throw errorWithCode('The session needs expiresAt or a positive maxSeconds.', 'invalid_session');
  }
  return Math.max(0, Math.min(...deadlines) - Date.now());
}

/**
 * Receive a bounded Ring WHEP session through application-owned HTTP callbacks.
 *
 * start() resolves with the session after SDP negotiation, or null after a close.
 * Setup failures reject start() and emit an error state. onFirstFrame reports
 * decoded video separately. Background failures close locally and emit a state.
 * close() waits for release, including a late createSession result. Release
 * failures emit reason=release_failed with the affected session and current state.
 * A fresh start can run while an older generation finishes releasing.
 */
export function createRingViewer({
  video,
  createSession,
  releaseSession,
  onStateChange,
  onFirstFrame,
  rtcConfiguration = DEFAULT_RTC_CONFIGURATION,
  iceGatheringTimeoutMs = 8000,
  requestTimeoutMs = 25000,
  firstFrameTimeoutMs = 20000,
} = {}) {
  if (!video || typeof video.addEventListener !== 'function') {
    throw new TypeError('video must be an HTML video element.');
  }
  if (typeof createSession !== 'function' || typeof releaseSession !== 'function') {
    throw new TypeError('Provide createSession and releaseSession functions.');
  }
  for (const [name, value] of Object.entries({iceGatheringTimeoutMs, requestTimeoutMs, firstFrameTimeoutMs})) {
    if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
      throw new RangeError(`${name} must be a finite timer duration from 0 to 2147483647 ms.`);
    }
  }
  let active = null;
  let state = 'idle';
  const cleanups = new Set();

  function observerFailed(run, event, error) {
    run.callbackError = error;
    if (!run.closed) {
      retire(run, 'error', 'state_callback_failed', error, false);
      try {
        Promise.resolve(onStateChange?.({...event, state: 'error', reason: 'state_callback_failed', error}))
          .catch(() => {});
      } catch { /* The observer already received its own exception. */ }
    }
  }

  function announce(run, next, details = {}) {
    state = next;
    const event = {state, ...(run.session ? {session: run.session} : {}), ...details};
    try { Promise.resolve(onStateChange?.(event)).catch(error => observerFailed(run, event, error)); }
    catch (error) { observerFailed(run, event, error); }
  }

  function release(run) {
    if (!run.session?.sessionId) return Promise.resolve();
    if (run.releasePromise) return run.releasePromise;
    run.releasePromise = Promise.resolve()
      .then(() => releaseSession(run.session.sessionId, run.closeReason))
      .catch(error => {
        // A late release belongs to its original session; the newer view keeps its state.
        announce(run, state, {reason: 'release_failed', error});
      });
    return run.releasePromise;
  }

  function retire(run, next, reason, error, notify = true) {
    if (run.closed) return run.cleanupPromise;
    run.closed = true;
    run.closeReason = reason;
    const wasActive = active === run;
    if (wasActive) active = null;
    run.controller.abort();
    clearTimeout(run.expiryTimer);
    clearTimeout(run.frameTimer);
    if (run.frameCallback !== null) video.cancelVideoFrameCallback?.(run.frameCallback);
    for (const remove of run.listeners) remove();
    const tracks = new Set(run.media?.getTracks() || []);
    for (const receiver of run.peer?.getReceivers?.() || []) {
      if (receiver.track) tracks.add(receiver.track);
    }
    for (const track of tracks) track.stop();
    run.peer?.close();
    if (run.media && video.srcObject === run.media) {
      video.pause?.();
      video.srcObject = null;
    }
    run.cleanupPromise = Promise.resolve(run.creationPromise)
      .catch(() => {})
      .then(() => release(run));
    cleanups.add(run.cleanupPromise);
    run.cleanupPromise.then(() => cleanups.delete(run.cleanupPromise));
    if (wasActive) {
      if (notify) announce(run, next, {reason, ...(error ? {error} : {})});
      else state = next;
    }
    return run.cleanupPromise;
  }

  function listen(run, target, type, callback) {
    target.addEventListener(type, callback);
    run.listeners.push(() => target.removeEventListener(type, callback));
  }

  function firstFrame(run, source) {
    if (active !== run || run.closed || run.firstFrame || !run.session || video.srcObject !== run.media) return;
    run.firstFrame = true;
    clearTimeout(run.frameTimer);
    announce(run, 'playing');
    if (run.closed) return;
    const failed = error => {
      if (!run.closed) retire(run, 'error', 'first_frame_callback_failed', error);
      else announce(run, state, {reason: 'first_frame_callback_failed', error});
    };
    try {
      Promise.resolve(onFirstFrame?.({session: run.session, observedAt: new Date().toISOString(), source}))
        .catch(failed);
    } catch (error) { failed(error); }
  }

  async function connect(run) {
    try {
      if (run.closed) return null;
      announce(run, 'connecting');
      if (run.callbackError) throw run.callbackError;
      if (run.closed) return null;
      if (typeof globalThis.RTCPeerConnection !== 'function' || typeof globalThis.MediaStream !== 'function') {
        throw errorWithCode('This browser needs WebRTC and MediaStream support.', 'webrtc_unavailable');
      }
      const peer = run.peer = new globalThis.RTCPeerConnection(rtcConfiguration);
      const media = run.media = new globalThis.MediaStream();
      peer.addTransceiver('video', {direction: 'recvonly'});
      peer.addTransceiver('audio', {direction: 'recvonly'});
      video.srcObject = media;
      listen(run, peer, 'track', event => {
        if (active !== run || run.closed) { event.track.stop(); return; }
        try {
          media.addTrack(event.track);
          Promise.resolve(video.play()).catch(error => {
            if (active === run && !run.firstFrame) {
              announce(run, 'waiting', {reason: 'playback_requires_gesture', error});
            }
          });
        } catch (error) { retire(run, 'error', 'media_failed', error); }
      });
      listen(run, peer, 'connectionstatechange', () => {
        if (active === run && ['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
          retire(run, 'interrupted', `peer_${peer.connectionState}`);
        }
      });
      listen(run, video, 'error', () => {
        if (active === run) {
          retire(run, 'error', 'media_failed', errorWithCode(video.error?.message || 'Video playback failed.', 'media_failed'));
        }
      });
      const page = video.ownerDocument?.defaultView || globalThis.window;
      if (page?.addEventListener) listen(run, page, 'pagehide', () => retire(run, 'ended', 'page_hidden'));
      const offer = await peer.createOffer();
      if (run.closed) return null;
      await peer.setLocalDescription(offer);
      await waitForIce(peer, run.controller.signal, iceGatheringTimeoutMs);
      if (run.closed) return null;
      if (!peer.localDescription?.sdp) throw errorWithCode('WebRTC returned an empty SDP offer.', 'invalid_offer');
      run.creationPromise = Promise.resolve()
        .then(() => createSession({offer: peer.localDescription.sdp, signal: run.controller.signal}))
        .then(session => { run.session = session; return session; });
      const session = await waitForSession(run.creationPromise, run.controller, requestTimeoutMs);
      if (run.closed) return null;
      if (!session || typeof session.sessionId !== 'string' || !session.sessionId
        || typeof session.answer !== 'string' || !session.answer) {
        throw errorWithCode('The session needs a sessionId and an SDP answer.', 'invalid_session');
      }
      const remainingMs = remainingLifetime(session, Date.now());
      if (remainingMs === 0) {
        retire(run, 'ended', 'session_expired');
        return null;
      }
      run.expiryTimer = setTimeout(() => retire(run, 'ended', 'session_expired'), Math.min(remainingMs, 2_147_483_647));
      if (typeof video.requestVideoFrameCallback === 'function') {
        run.frameCallback = video.requestVideoFrameCallback(() => firstFrame(run, 'video-frame-callback'));
      } else {
        const decodedFrame = source => {
          if (video.readyState >= 2 && video.videoWidth > 0) firstFrame(run, source);
        };
        listen(run, video, 'loadeddata', () => decodedFrame('loadeddata'));
        listen(run, video, 'playing', () => decodedFrame('playing'));
        run.checkExistingFrame = () => decodedFrame('ready-state');
      }
      await peer.setRemoteDescription({type: 'answer', sdp: session.answer});
      if (run.closed) return null;
      run.checkExistingFrame?.();
      if (run.closed) return null;
      if (!run.firstFrame) {
        announce(run, 'waiting');
        if (run.closed) return null;
        run.frameTimer = setTimeout(() => {
          if (!run.firstFrame) {
            retire(run, 'error', 'first_frame_timeout', errorWithCode('The first video frame exceeded its deadline.', 'first_frame_timeout'));
          }
        }, firstFrameTimeoutMs);
      }
      return session;
    } catch (error) {
      if (run.closed && !run.callbackError) return null;
      retire(run, 'error', error.code || 'start_failed', error);
      throw error;
    }
  }

  return {
    start() {
      if (active) return active.startPromise;
      const run = {
        controller: new AbortController(), listeners: [], closed: false,
        peer: null, media: null, session: null, creationPromise: null,
        frameCallback: null, firstFrame: false,
      };
      active = run;
      run.startPromise = Promise.resolve().then(() => connect(run));
      // Callers can await the original promise; event-only consumers receive the error state.
      run.startPromise.catch(() => {});
      return run.startPromise;
    },
    close(reason = 'viewer_closed') {
      if (active) retire(active, 'ended', reason);
      return Promise.all([...cleanups]).then(() => {});
    },
    get state() { return state; },
    get session() { return active?.session || null; },
  };
}
