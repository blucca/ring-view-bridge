import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {createRingViewer} from '../src/browser.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function browser(t, {frameCallback = true, remoteError} = {}) {
  const peers = [];
  class Stream {
    tracks = [];
    addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
    getTracks() { return this.tracks; }
  }
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    connectionState = 'connecting';
    transceivers = [];
    receivers = [];
    closeCalls = 0;
    constructor(configuration) {
      super();
      this.configuration = configuration;
      peers.push(this);
    }
    addTransceiver(kind, options) { this.transceivers.push({kind, ...options}); }
    async createOffer() { return {type: 'offer', sdp: 'v=0\r\nmock-offer'}; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      if (remoteError) throw remoteError;
    }
    getReceivers() { return this.receivers; }
    close() { this.closeCalls += 1; this.connectionState = 'closed'; }
    track() {
      const track = {stopCalls: 0, stop() { this.stopCalls += 1; }};
      this.receivers.push({track});
      const event = new Event('track');
      Object.assign(event, {track, streams: []});
      this.dispatchEvent(event);
      return track;
    }
  }
  for (const [name, value] of Object.entries({RTCPeerConnection: Peer, MediaStream: Stream})) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const page = new EventTarget();
  const video = new EventTarget();
  Object.assign(video, {
    srcObject: null,
    readyState: 0,
    videoWidth: 0,
    ownerDocument: {defaultView: page},
    playCalls: 0,
    async play() { this.playCalls += 1; },
    pauseCalls: 0,
    pause() { this.pauseCalls += 1; },
  });
  const callbacks = new Map();
  if (frameCallback) {
    video.requestVideoFrameCallback = callback => { callbacks.set(1, callback); return 1; };
    video.cancelVideoFrameCallback = id => callbacks.delete(id);
  }
  return {
    video, peers, page,
    frame() {
      for (const [id, callback] of callbacks) {
        callbacks.delete(id);
        callback(1, {mediaTime: 0, presentedFrames: 1});
      }
    },
  };
}

function session(id = 'session-1', maxSeconds = 60) {
  const startedAt = new Date().toISOString();
  return {sessionId: id, answer: 'v=0\r\nmock-answer', startedAt,
    expiresAt: new Date(Date.now() + maxSeconds * 1000).toISOString(), maxSeconds};
}

test('receives video and audio, reports a decoded frame once, and releases at the upstream deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_800_000_000_000});
  const b = browser(t);
  const events = [];
  const frames = [];
  const releases = [];
  const issued = session('bounded', 60);
  issued.startedAt = new Date(Date.now() - 50_000).toISOString();
  issued.expiresAt = new Date(Date.now() + 10_000).toISOString();
  const viewer = createRingViewer({
    video: b.video,
    createSession: async ({offer, signal}) => {
      assert.match(offer, /mock-offer/);
      assert.equal(signal.aborted, false);
      return issued;
    },
    releaseSession: async (...args) => releases.push(args),
    onStateChange: event => events.push(event),
    onFirstFrame: event => frames.push(event),
  });
  assert.equal(viewer.state, 'idle');
  assert.equal(viewer.session, null);
  const opening = viewer.start();
  assert.equal(viewer.start(), opening);
  assert.equal(await opening, issued);
  assert.equal(viewer.state, 'waiting');
  assert.equal(viewer.session, issued);
  assert.deepEqual(b.peers[0].transceivers, [
    {kind: 'video', direction: 'recvonly'}, {kind: 'audio', direction: 'recvonly'},
  ]);
  const track = b.peers[0].track();
  b.video.dispatchEvent(new Event('loadeddata'));
  assert.equal(frames.length, 0);
  b.frame();
  b.video.dispatchEvent(new Event('playing'));
  assert.equal(viewer.state, 'playing');
  assert.deepEqual(frames, [{session: issued, observedAt: new Date().toISOString(), source: 'video-frame-callback'}]);
  t.mock.timers.tick(9_999);
  assert.equal(viewer.state, 'playing');
  t.mock.timers.tick(1);
  await viewer.close();
  await viewer.close();
  assert.equal(viewer.state, 'ended');
  assert.equal(viewer.session, null);
  assert.equal(events.at(-1).reason, 'session_expired');
  assert.deepEqual(releases, [['bounded', 'session_expired']]);
  assert.equal(track.stopCalls, 1);
  assert.equal(b.peers[0].closeCalls, 1);
  assert.equal(b.video.srcObject, null);
});

test('close aborts an in-flight create and returns its late session while a fresh start stays active', async t => {
  const b = browser(t);
  const late = deferred();
  const releases = [];
  let calls = 0;
  let pendingSignal;
  const viewer = createRingViewer({
    video: b.video,
    createSession: ({signal}) => {
      calls += 1;
      if (calls === 1) { pendingSignal = signal; return late.promise; }
      return session('fresh');
    },
    releaseSession: async (...args) => releases.push(args),
  });
  const first = viewer.start();
  await nextTurn();
  assert.equal(calls, 1);
  let released = false;
  const closing = viewer.close('user_closed').then(() => { released = true; });
  assert.equal(pendingSignal.aborted, true);
  assert.equal(await first, null);
  assert.equal(released, false);
  assert.equal(b.peers[0].closeCalls, 1);
  const fresh = await viewer.start();
  const newStream = b.video.srcObject;
  late.resolve(session('late'));
  await closing;
  assert.equal(released, true);
  assert.deepEqual(releases, [['late', 'user_closed']]);
  assert.equal(viewer.session, fresh);
  assert.equal(viewer.state, 'waiting');
  assert.equal(b.video.srcObject, newStream);
  await Promise.all([viewer.close(), viewer.close()]);
  assert.deepEqual(releases, [['late', 'user_closed'], ['fresh', 'viewer_closed']]);
  assert.equal(b.peers[1].closeCalls, 1);
});

test('SDP failure releases once, and release errors are delivered as events with the affected session', async t => {
  const failure = new Error('The answer was rejected.');
  const releaseError = new Error('The release endpoint failed.');
  const b = browser(t, {remoteError: failure});
  const events = [];
  let releases = 0;
  const viewer = createRingViewer({
    video: b.video,
    createSession: async () => session('failed-answer'),
    releaseSession: async () => { releases += 1; throw releaseError; },
    onStateChange: event => events.push(event),
  });
  await assert.rejects(viewer.start(), error => error === failure);
  await Promise.all([viewer.close(), viewer.close()]);
  assert.equal(releases, 1);
  assert.equal(viewer.state, 'error');
  assert.equal(b.peers[0].closeCalls, 1);
  assert.equal(b.video.srcObject, null);
  assert.equal(events.find(event => event.reason === 'start_failed').error, failure);
  assert.equal(events.at(-1).reason, 'release_failed');
  assert.equal(events.at(-1).error, releaseError);
  assert.equal(events.at(-1).session.sessionId, 'failed-answer');
});

test('older browsers report loadeddata and pagehide releases the session', async t => {
  const b = browser(t, {frameCallback: false});
  const frames = [];
  const releases = [];
  const viewer = createRingViewer({
    video: b.video,
    rtcConfiguration: {iceServers: []},
    createSession: async () => session('fallback'),
    releaseSession: async (...args) => releases.push(args),
    onFirstFrame: event => frames.push(event),
  });
  await viewer.start();
  assert.deepEqual(b.peers[0].configuration, {iceServers: []});
  b.video.dispatchEvent(new Event('loadeddata'));
  assert.equal(frames.length, 0);
  b.video.readyState = 2;
  b.video.dispatchEvent(new Event('loadeddata'));
  assert.equal(frames.length, 0);
  b.video.videoWidth = 640;
  b.video.dispatchEvent(new Event('loadeddata'));
  b.video.dispatchEvent(new Event('loadeddata'));
  b.video.dispatchEvent(new Event('playing'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'loadeddata');
  b.page.dispatchEvent(new Event('pagehide'));
  await viewer.close();
  assert.deepEqual(releases, [['fallback', 'page_hidden']]);
  assert.equal(viewer.state, 'ended');
});

test('the request deadline stops locally and a late successful response is released', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_800_000_000_000});
  const b = browser(t);
  const late = deferred();
  const releases = [];
  const viewer = createRingViewer({
    video: b.video, requestTimeoutMs: 20,
    createSession: () => late.promise,
    releaseSession: async (...args) => releases.push(args),
  });
  const opening = viewer.start();
  await nextTurn();
  t.mock.timers.tick(20);
  await assert.rejects(opening, {code: 'request_timeout'});
  assert.equal(viewer.state, 'error');
  assert.equal(b.peers[0].closeCalls, 1);
  late.resolve(session('late-timeout'));
  await viewer.close();
  assert.deepEqual(releases, [['late-timeout', 'request_timeout']]);
});
