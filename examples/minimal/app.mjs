import {createRingViewer} from '/ring-view-bridge.mjs';

const openButton = document.querySelector('#open');
const closeButton = document.querySelector('#close');
const labels = {idle: 'Ready to connect', connecting: 'Creating a Ring session…', waiting: 'Waiting for the first frame…',
  playing: 'Live · receive-only', interrupted: 'Connection interrupted', ended: 'View ended', error: 'Connection failed'};
const events = [];
let requestedAt;
function log(event) {
  events.push(`${new Date().toLocaleTimeString()}  ${event}`);
  document.querySelector('#events').textContent = events.slice(-12).join('\n');
}
const viewer = createRingViewer({
  video: document.querySelector('video'),
  createSession: async ({offer, signal}) => {
    const response = await fetch('/api/live-sessions', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({offer}), signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Starting the Ring session failed.');
    return result;
  },
  releaseSession: async sessionId => {
    const response = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: '{}', keepalive: true});
    if (!response.ok) throw new Error(`Session cleanup failed (HTTP ${response.status}).`);
  },
  onStateChange: ({state, reason, error}) => {
    document.querySelector('#state').textContent = error?.message || labels[state];
    openButton.disabled = ['connecting', 'waiting', 'playing'].includes(state);
    closeButton.disabled = !openButton.disabled;
    log([state, reason, error?.message].filter(Boolean).join(' · '));
  },
  onFirstFrame: ({session, source}) => {
    document.querySelector('#first-frame').textContent = `First frame in ${((performance.now() - requestedAt) / 1000).toFixed(1)} s · ${source}`;
    log(`session ${session.sessionId} · expires ${session.expiresAt}`);
  },
});
openButton.addEventListener('click', () => {
  requestedAt = performance.now();
  void viewer.start().catch(() => {});
});
closeButton.addEventListener('click', () => { void viewer.close(); });
