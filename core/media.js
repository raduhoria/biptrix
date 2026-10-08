import { createHmac } from 'node:crypto';
import { createSfu } from './sfu.js';

const TURN_TTL_S = 4 * 3600;

// Media provider adapter (spec §8, §20). ICE servers are issued per
// participant only after admission, with short-lived TURN credentials:
//   - Cloudflare Realtime TURN (CF_TURN_KEY_ID + CF_TURN_API_TOKEN), or
//   - coturn with use-auth-secret (TURN_URLS + TURN_SECRET, TURN REST scheme),
//   - otherwise the static ICE_SERVERS (STUN only → no relay behind strict NAT).
// Topology: 'sfu' (Cloudflare Realtime SFU, core/sfu.js; capacity from the
// org policy) or 'mesh' (peer-to-peer, up to MESH_MAX_PARTICIPANTS).
export function createMedia(config) {
  const { iceServers, cfTurnKeyId, cfTurnApiToken, turnUrls, turnSecret, meshMax, forceRelay, topology, sfuAppId, sfuAppToken } = config.media;
  const sfu = createSfu({ appId: sfuAppId, appToken: sfuAppToken });
  if (topology === 'sfu' && !sfu.enabled) throw new Error('MEDIA_TOPOLOGY=sfu requires CF_SFU_APP_ID and CF_SFU_APP_TOKEN');
  const chosen = topology === 'mesh' || !sfu.enabled ? 'mesh' : 'sfu';

  async function cloudflare() {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cfTurnKeyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfTurnApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
    const body = await res.json();
    return [].concat(body.iceServers || []);
  }

  function coturn(participantId) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${participantId}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    return [{ urls: turnUrls, username, credential }];
  }

  async function iceServersFor(participantId) {
    try {
      // Cloudflare's list already contains its STUN servers.
      if (cfTurnKeyId && cfTurnApiToken) return await cloudflare();
    } catch (err) {
      console.error('TURN credentials failed, falling back to STUN:', err.message);
    }
    if (turnUrls.length && turnSecret) return [...iceServers, ...coturn(participantId)];
    return iceServers;
  }

  // forceRelay (MEDIA_FORCE_RELAY=1): clients use relay candidates only —
  // for testing TURN / restrictive-NAT behavior (spec §18, criterion 24).
  return { iceServersFor, topology: chosen, sfu, meshMax, icePolicy: forceRelay ? 'relay' : 'all' };
}
