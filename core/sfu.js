// Cloudflare Realtime SFU adapter (spec §8: group meetings through an SFU,
// behind an adapter; the API token never leaves the server).
// API: https://rtc.live.cloudflare.com/v1/apps/{appId}/sessions/...
//   sessions/new → { sessionId }        one WebRTC session per participant
//   tracks/new   → push local tracks (offer → answer) or pull remote tracks
//                  (→ offer, requiresImmediateRenegotiation)
//   renegotiate  → the client's answer to an SFU offer
//   tracks/close → stop publishing / subscriptions (force: no SDP exchange)
const BASE = 'https://rtc.live.cloudflare.com/v1/apps';

export function createSfu({ appId, appToken }) {
  const enabled = !!(appId && appToken);

  // partial: per-track failures are returned (track.errorCode) instead of
  // thrown, so the caller can apply the SDP for the tracks that succeeded.
  async function call(method, path, body, { partial = false } = {}) {
    const res = await fetch(`${BASE}/${appId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { errorDescription: text.slice(0, 200) };
    }
    if (!res.ok || data.errorCode) {
      throw Object.assign(new Error(`SFU ${path.split('/').slice(-2).join('/')}: ${data.errorDescription || data.errorCode || res.status}`), { code: 'sfu_error', expose: true });
    }
    // Per-track failures are reported item by item.
    const failed = (data.tracks || []).find((t) => t.errorCode);
    if (failed && !partial) throw Object.assign(new Error(`SFU track ${failed.trackName || failed.mid}: ${failed.errorDescription || failed.errorCode}`), { code: 'sfu_error', expose: true });
    return data;
  }

  return {
    enabled,
    newSession: async () => (await call('POST', '/sessions/new')).sessionId,
    // tracks: [{ mid, trackName }] from the client's offer.
    push: (sessionId, offer, tracks) =>
      call('POST', `/sessions/${sessionId}/tracks/new`, { sessionDescription: offer, tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })) }),
    // tracks: [{ sessionId, trackName }] published by others.
    // A track that is not sending yet fails with an errorCode; the others
    // still come back with an SFU offer to apply.
    pull: (sessionId, tracks) =>
      call('POST', `/sessions/${sessionId}/tracks/new`, { tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName })) }, { partial: true }),
    renegotiate: (sessionId, answer) => call('PUT', `/sessions/${sessionId}/renegotiate`, { sessionDescription: answer }),
    close: (sessionId, mids) => call('PUT', `/sessions/${sessionId}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true }, { partial: true }),
  };
}
