import { createServer } from './server.js';
import { config } from './config.js';

const server = createServer();

server.listen(config.port, () => {
  console.log(`[duckgo] listening on http://localhost:${config.port}`);
  console.log(`[duckgo] upstream: ${config.baseUrl}`);
  console.log(`[duckgo] auth: ${config.token ? 'enabled (TOKEN)' : 'disabled'}`);
});
