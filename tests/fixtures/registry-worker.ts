import { join } from 'node:path';
import { Engine } from '../../src/runtime/engine.js';
import { FileDeviceRegistry } from '../../src/runtime/device-registry.js';
import { Store } from '../../src/runtime/storage.js';

const [root, directory, username, mode] = process.argv.slice(2) as [string, string, string, string?];
const testVault = { protect: async (b: Buffer) => b, unprotect: async (b: Buffer) => b };
const store = new Store(join(root, directory), testVault);
const registry = new FileDeviceRegistry(join(root, 'registry'), {
  ...testVault, protect: async data => {
    if (mode === 'crash-before-replace') process.exit(37);
    return data;
  },
});
await store.open();
try {
  const engine = new Engine(store, async () => { throw Error('unexpected network'); }, registry);
  await engine.initialize();
  const account = await engine.addAccount('Example', username, {
    baseUrl: 'https://campus.invalid/api/', name: 'Test Campus', nameEn: 'Test Campus',
    id: 'tenant', code: 'test', randomCode: '', provinceCode: '',
  });
  process.stdout.write(JSON.stringify(account.device));
} finally { store.close(); }
