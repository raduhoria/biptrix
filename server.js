import { createApp } from './app.js';
import { loadConfig } from './config/env.js';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — the environment may already be set (systemd, shell).
}

// A failure in background work (an e-mail, a notification) is logged
// instead of stopping the server for everyone.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const config = loadConfig();
const { server, close } = await createApp(config);
server.listen(config.port, config.host || undefined, () => {
  console.log(`Biptrix ${config.nodeId} listening on http://${config.host || 'localhost'}:${config.port} (db: ${config.db.driver}${config.cluster ? ', cluster' : ''})`);
});

// systemd stop / Ctrl+C: stop accepting, close sockets, flush the database.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await close().catch(() => {});
    process.exit(0);
  });
}
