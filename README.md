# Ring View Bridge

**A 60-second Ring view. A complete lifecycle.**

Bring a Ring camera into a plain HTML page or an existing application. This small, framework-free pair handles the official WHEP exchange, server-owned session lifetime, receive-only WebRTC, first-frame reporting, and cleanup when a viewer leaves.

**Node.js 22+ · native browser modules · zero runtime dependencies · MIT**

[Minimal working app](examples/minimal) · [API & lifecycle](#the-lifecycle) · [Care Handoff integration](https://github.com/blucca/care-handoff) · [Official Ring API](https://developer.amazon.com/docs/ring/api-documentation.html)

## Run the complete example

1. Open the [Ring Developer Playground](https://developer.amazon.com/ring/console/playground), generate a token, and copy the device ID. Playground tokens last about 30 minutes.
2. Save the token to a private file and select an official Package, Vehicle, or Motion preview in the Playground.
3. Run:

```sh
git clone https://github.com/blucca/ring-view-bridge.git
cd ring-view-bridge
RING_TOKEN_FILE=/absolute/path/to/ring-token.txt \
RING_DEVICE_ID=your-device-id \
npm start
```

Open **http://127.0.0.1:4325/** and select **Open 60-second view**. The page shows a live stream, first-frame timing, and session events. Close it early or let its deadline end the view. The backend calls Ring's session DELETE in both cases.

`RING_ACCESS_TOKEN` provides an environment-variable alternative. Updating the token file takes effect on the next upstream request. The example binds to loopback and selects the device on the server. `PORT` changes the local port.

![The standalone example receiving official Ring Playground frames with first-frame timing and lifecycle events.](docs/minimal-live.png)

The screenshot uses official simulated Package footage: [“Thief stealing our package”](https://www.youtube.com/watch?v=TfTFu8lGrwk) by [frollard](https://www.youtube.com/@frollard), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), captured and scaled within the app.

## Add it to an existing app

Install the versioned GitHub Release package:

```sh
npm install https://github.com/blucca/ring-view-bridge/releases/download/v0.1.1/blucca-ring-view-bridge-0.1.1.tgz
```

With npm 12+, add `--allow-remote=root` to opt in to this direct Release dependency.

### Server: keep the token and upstream Location private

```js
import {RingWhepClient, LiveSessionPool, assertSameOrigin} from '@blucca/ring-view-bridge/node';

const sessions = new LiveSessionPool({
  client: new RingWhepClient({getAccessToken: () => process.env.RING_ACCESS_TOKEN}),
  maxSessions: 2,
  lifetimeMs: 60_000,
  onEvent: event => console.log(event), // timestamps, local ID, lifecycle outcome
});

// Inside your authenticated, same-origin POST route:
assertSameOrigin(request, 'https://your-app.example');
const session = await sessions.open({deviceId: authorizedDeviceId, offer: body.offer});
// Respond with session: local sessionId, answer, startedAt, expiresAt, maxSeconds.

// Inside your DELETE route:
await sessions.close(localSessionId);

// During graceful shutdown, including creates already in flight:
const result = await sessions.closeAll();
```

The [complete Node example](examples/minimal/server.mjs) includes body-size limits, exact routes, JSON errors, disconnect cleanup, and origin checks. Your application supplies user authentication and the user's authorized device. `assertSameOrigin` checks the configured origin, fetch-site metadata, and JSON content type; command-line clients can omit the Origin header.

### Browser: supply a video element and two transport functions

```js
import {createRingViewer} from '@blucca/ring-view-bridge/browser';

const viewer = createRingViewer({
  video: document.querySelector('video'),
  createSession: async ({offer, signal}) => {
    const res = await fetch('/api/live-sessions', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({offer}), signal,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error.message);
    return body;
  },
  releaseSession: async sessionId => {
    const res = await fetch(`/api/live-sessions/${sessionId}`, {
      method: 'DELETE', headers: {'Content-Type': 'application/json'},
      body: '{}', keepalive: true,
    });
    if (!res.ok) throw new Error('Session cleanup failed.');
  },
  onStateChange: ({state}) => { statusElement.textContent = state; },
  onFirstFrame: ({session, observedAt, source}) => {
    console.log('First frame', session.sessionId, observedAt, source);
  },
});

await viewer.start();
await viewer.close();
```

A bundler can resolve the package import. For native browser modules, serve `src/browser.mjs` at a same-origin URL; the example maps it to `/ring-view-bridge.mjs`. The supplied `<video>` should use `autoplay muted playsinline`; the receiver requests audio and video in `recvonly` mode. Application code controls the UI and business actions.

## The lifecycle

```text
Browser                 Your Node server                    Ring API
  create offer ──────────► reserve local slot
                           POST SDP ─────────────────────────► WHEP session
  ◄── answer + local ID ── save private Location ◄──────────── SDP + Location
  receive frames          start server deadline
  first-frame callback
  close / pagehide ──────► DELETE saved Location ─────────────► release session
                           release slot
```

- **Creates consume capacity immediately.** `activeCount` includes pending creation and deletion. The default pool has two slots.
- **Each ready session gets an explicit deadline.** Default lifetime: 60 seconds. Server and browser independently schedule cleanup from session metadata.
- **Closing during startup gets its own cleanup path.** A late-created upstream session is released. Graceful server shutdown awaits pending creates and their DELETEs.
- **Repeated close shares the in-flight result.** Successful cleanup releases the slot; subsequent closes resolve successfully.
- **Failed DELETE remains visible, including cleanup after invalid startup SDP.** The pool emits `close_failed`, keeps the slot reserved, and accepts an explicit `close(sessionId)` retry. `closeAll()` returns `failedSessionIds` for operational follow-up.
- **First frame is measured at the video element.** Modern browsers use `requestVideoFrameCallback`; the fallback uses loaded video data. The callback includes the observation source.
- **Tokens and upstream URLs stay server-side.** JSON session responses and pool events expose the local UUID and lifecycle metadata. Returned WHEP Locations must match the configured Ring origin and requested device path.

### API details

`RingWhepClient` accepts `accessToken` or a sync/async `getAccessToken` function, `baseUrl` (default `https://api.amazonvision.com`), and `timeoutMs` (default 8000; maximum 30000). SDP is bounded to 96 KiB. DELETE 404/410 is treated as an ended upstream session. Errors expose `{code, message, status}` through `RingError.toJSON()`.

`LiveSessionPool` accepts `client`, `maxSessions` (1–100), `lifetimeMs` (1–300000), and `onEvent`. `has(id)` reports an open ready session; `get(id)` returns public metadata. A pool's limits and sessions belong to its Node process. Route all requests for a session to that process. Start a fresh pool after shutdown.

`createRingViewer` exposes `start()`, `close(reason?)`, `state`, and `session`. `start()` resolves after SDP setup, returns `null` for a cancelled start, and rejects on startup failure. `onFirstFrame` reports playback separately. States are `idle`, `connecting`, `waiting`, `playing`, `interrupted`, `ended`, and `error`. Options include `rtcConfiguration`, `iceGatheringTimeoutMs`, `requestTimeoutMs`, and `firstFrameTimeoutMs`. Default STUN servers follow the Ring Hello World example. Supply your network's ICE configuration where needed.

For a linked production Ring account, supply the account's access token through `getAccessToken` and maintain refresh-token rotation in your account-linking layer. The Playground example uses explicitly generated short-lived credentials.

## Used by Care Handoff

[Care Handoff](https://github.com/blucca/care-handoff) uses this independent package for its live doorway dialog. The application owns visit coordination, device discovery, event history, and named human updates. Ring View Bridge owns streaming transport and lifecycle. [Integration and official run records](docs/integration-run.md) document the released package, browser frames, and upstream cleanup.

The code originated in Care Handoff's working Ring integration and was extracted into a reusable library during the 2026 Amazon Developer Hackathon. The standalone app, transport callbacks, typed API, bounded pool, and lifecycle tests are maintained here for other Ring developers.

## Contribute

```sh
npm test
```

Tests use a local HTTP fixture and browser API doubles. The official Playground run is recorded separately. Reproduce a lifecycle issue with the smallest start/close sequence, browser version, and sanitized event timestamps, then [open an issue](https://github.com/blucca/ring-view-bridge/issues).

## License & sources

[MIT](LICENSE), copyright blucca. Endpoint and media contracts follow the [Ring Partner API](https://developer.amazon.com/docs/ring/api-documentation.html); setup and default STUN servers follow [AmazonAppDev/ring-api-helloworld](https://github.com/AmazonAppDev/ring-api-helloworld). The minimal app displays the active Ring source; Playground footage is simulated. Development is performed by an autonomous AI coding agent through the blucca account, with account identity handled by its owner.
