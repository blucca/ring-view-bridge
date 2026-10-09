import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {RingWhepClient, LiveSessionPool, RingError, assertSameOrigin} from '../src/node.mjs';

const offer = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n';
const answer = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n';
const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };

test('official-shaped WHEP exchange preserves private Location and validates device/origin', async () => {
  const calls = [];
  let location = '/v1/devices/camera-1/media/streaming/whep/sessions/session-1?private=key';
  let reply = answer;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({method: req.method, url: req.url, body});
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (req.method === 'DELETE') {res.writeHead(410); return res.end();}
    assert.equal(req.headers['content-type'], 'application/sdp');
    res.writeHead(201, {'Content-Type': 'application/sdp', Location: location});
    res.end(reply);
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  try {
    const client = new RingWhepClient({getAccessToken: () => 'fixture-token', baseUrl: `http://127.0.0.1:${upstream.address().port}`});
    const pool = new LiveSessionPool({client});
    const session = await pool.open({deviceId: 'camera-1', offer});
    assert.equal(session.answer, answer);
    assert.equal(session.maxSeconds, 60);
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.startedAt), 60_000);
    assert.equal(JSON.stringify([session, pool.get(session.sessionId), client]).includes('private=key'), false);
    assert.equal(JSON.stringify(client).includes('fixture-token'), false);
    await pool.close(session.sessionId);
    assert.equal(calls[1].url, location);
    assert.equal(calls[1].method, 'DELETE');
    assert.equal(pool.activeCount, 0);
    await assert.rejects(client.closeLiveSession('camera-2', location), e => e.code === 'ring_invalid_response');
    location = 'https://outside.example/session-1';
    await assert.rejects(client.startLiveSession('camera-1', offer), e => e.code === 'ring_invalid_response');
    location = '/v1/devices/camera-1/media/streaming/whep/sessions/session-2';
    reply = 'invalid SDP';
    await assert.rejects(client.startLiveSession('camera-1', offer), e => e.code === 'ring_invalid_response');
    assert.equal(calls.at(-1).method, 'DELETE');
  } finally { upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); }
});

test('pending create consumes a slot; shutdown waits for creation and deletes it once', async () => {
  const pending = deferred();
  const deleted = [];
  const events = [];
  const pool = new LiveSessionPool({maxSessions: 1, onEvent: event => events.push(event), client: {
    startLiveSession: () => pending.promise,
    closeLiveSession: async (deviceId, sessionUrl) => deleted.push({deviceId, sessionUrl}),
  }});
  const starting = pool.open({deviceId: 'camera-1', offer});
  const rejectedStart = assert.rejects(starting, e => e.code === 'ring_session_ended');
  assert.equal(pool.activeCount, 1);
  await assert.rejects(pool.open({deviceId: 'camera-1', offer}), e => e.status === 429);
  const closing = pool.closeAll();
  pending.resolve({answer, sessionUrl: 'private-location'});
  assert.deepEqual(await closing, {closed: true, failedSessionIds: []});
  await rejectedStart;
  assert.equal(deleted.length, 1);
  assert.equal(pool.activeCount, 0);
  assert.deepEqual(events.map(e => e.type), ['started', 'closed']);
  assert.equal(JSON.stringify(events).includes('private-location'), false);
  await assert.rejects(pool.open({deviceId: 'camera-1', offer}), e => e.status === 503);
});

test('deadline closes once; failed cleanup reserves a slot and accepts explicit retry', async () => {
  const ended = deferred();
  let attempts = 0;
  const pool = new LiveSessionPool({maxSessions: 1, lifetimeMs: 15,
    onEvent: event => {if (event.type === 'close_failed') ended.resolve();},
    client: {startLiveSession: async () => ({answer, sessionUrl: 'private-location'}),
      closeLiveSession: async () => {if (++attempts === 1) throw new RingError('ring_network', 'Fixture failure.');}},
  });
  const session = await pool.open({deviceId: 'camera-1', offer});
  const deadline = setTimeout(() => ended.resolve(), 500);
  await ended.promise;
  clearTimeout(deadline);
  assert.equal(attempts, 1);
  assert.equal(pool.activeCount, 1);
  assert.equal(pool.has(session.sessionId), false);
  await assert.rejects(pool.open({deviceId: 'camera-1', offer}), e => e.status === 429);
  const first = pool.close(session.sessionId);
  assert.equal(pool.close(session.sessionId), first);
  await first;
  await pool.close(session.sessionId);
  assert.equal(attempts, 2);
  assert.equal(pool.activeCount, 0);
});

test('failed creation frees its reserved slot and observer errors preserve cleanup', async () => {
  let fail = true;
  const pool = new LiveSessionPool({onEvent: () => {throw new Error('observer');}, client: {
    startLiveSession: async () => {if (fail) throw new RingError('ring_auth', 'Fixture auth failure.', 401); return {answer, sessionUrl: 'private'};},
    closeLiveSession: async () => ({closed: true}),
  }});
  await assert.rejects(pool.open({deviceId: 'camera-1', offer}), e => e.status === 401);
  assert.equal(pool.activeCount, 0);
  fail = false;
  const session = await pool.open({deviceId: 'camera-1', offer});
  await pool.close(session.sessionId);
  assert.equal(pool.activeCount, 0);
});

test('origin/content-type guard and credential configuration expose actionable errors', () => {
  const headers = {origin: 'http://127.0.0.1:4325', 'content-type': 'application/json; charset=utf-8'};
  assertSameOrigin({headers}, headers.origin);
  assert.throws(() => assertSameOrigin({headers}, 'https://other.example'), e => e.status === 403);
  assert.throws(() => assertSameOrigin({headers: {...headers, 'sec-fetch-site': 'cross-site'}}, headers.origin), e => e.status === 403);
  assert.throws(() => assertSameOrigin({headers: {...headers, 'content-type': 'text/plain'}}, headers.origin), e => e.status === 415);
  assert.throws(() => new RingWhepClient({accessToken: 'fixture', baseUrl: 'http://outside.example'}), e => e.code === 'ring_configuration');
  assert.throws(() => new RingWhepClient(), e => e.status === 503);
});
