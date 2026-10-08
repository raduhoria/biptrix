import { randomBytes } from 'node:crypto';

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

// loadConfig: reads process.env (already populated by process.loadEnvFile()
// in server.js) into a plain config object with defaults.
export function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 3000;
  return {
    port,
    // Loopback by default; set HOST=0.0.0.0 (or an interface address) to
    // expose the server — normally only nginx should reach it.
    host: env.HOST || '127.0.0.1',
    appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
    cookieSecure: env.COOKIE_SECURE === '1',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS) || 72,
    dev: env.NODE_ENV === 'development',
    // Key for TOTP secrets and OTP HMACs. Unset → generated once into
    // appSecretFile (keep it outside the release directory on servers).
    appSecret: env.APP_SECRET || '',
    appSecretFile: env.APP_SECRET_FILE || './data/.app-secret',
    // Required in ?token= by the first-run /setup page when set.
    setupToken: env.SETUP_TOKEN || '',

    db: {
      driver: env.DB_DRIVER === 'rqlite' ? 'rqlite' : 'sqlite',
      sqlitePath: env.SQLITE_PATH || './data/biptrix.db',
      rqliteUrls: list(env.RQLITE_URL),
      rqliteUser: env.RQLITE_USER || '',
      rqlitePassword: env.RQLITE_PASSWORD || '',
      readConsistency: env.RQLITE_READ_CONSISTENCY || 'weak',
    },
    nodeId: env.NODE_ID || randomBytes(4).toString('hex'),
    cluster: env.CLUSTER === '1' || env.DB_DRIVER === 'rqlite',

    filesDir: env.FILES_DIR || './data/files',
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 25) * 1024 * 1024,
    avScanCmd: env.AV_SCAN_CMD || '',

    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 587,
      secure: env.SMTP_SECURE === '1',
      user: env.SMTP_USER || '',
      password: env.SMTP_PASSWORD || '',
      fromEmail: env.SMTP_FROM_EMAIL || '',
      fromName: env.SMTP_FROM_NAME || 'BipTrix',
    },

    media: {
      iceServers: env.ICE_SERVERS ? JSON.parse(env.ICE_SERVERS) : [{ urls: 'stun:stun.cloudflare.com:3478' }],
      cfTurnKeyId: env.CF_TURN_KEY_ID || '',
      cfTurnApiToken: env.CF_TURN_API_TOKEN || '',
      turnUrls: list(env.TURN_URLS),
      turnSecret: env.TURN_SECRET || '',
      meshMax: Number(env.MESH_MAX_PARTICIPANTS) || 6,
      sfuReturnMs: Number(env.MEDIA_SFU_RETURN_MS) || 20_000,
      forceRelay: env.MEDIA_FORCE_RELAY === '1',
      // auto = SFU when Cloudflare SFU credentials are set, mesh otherwise.
      topology: ['mesh', 'sfu'].includes(env.MEDIA_TOPOLOGY) ? env.MEDIA_TOPOLOGY : 'auto',
      sfuAppId: env.CF_SFU_APP_ID || '',
      sfuAppToken: env.CF_SFU_APP_TOKEN || '',
    },
  };
}
