import { log } from 'node:console';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// Keep the Mac mini's static-server contract while cf owns Worker build output.
const assets = fileURLToPath(new URL('../.cloudflare/output/v0/workers/default/assets/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/client/', import.meta.url));
if (!existsSync(new URL('../.cloudflare/output/v0/workers/default/assets/index.html', import.meta.url))) {
  throw new Error('Run cf build before staging the Mac mini frontend.');
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(assets, destination, { recursive: true });
log('Staged current Cloudflare assets in dist/client for the Mac mini.');
