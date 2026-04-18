import { defineNitroConfig } from 'nitro/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineNitroConfig({
  srcDir: resolve(__dirname, 'src/server'),
  alias: {
    '~': resolve(__dirname, 'src')
  },
  preset: process.env.NODE_ENV === 'production' ? 'vercel' : 'node-server',
  routeRules: {
    '/api/**': {
      cors: true,
      cache: false
    }
  }
});
