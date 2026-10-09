// This explicitly navigates public rooms. No messages, follows, gifts or profile actions.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { AndroidDriver } from '../src/android-driver.mjs';
import { RoomCollector } from '../src/room-collector.mjs';
const require = createRequire(import.meta.url);
const manager = require('../electron/services/client-manager');
const { createDataStore } = require('../electron/services/data-store');
if (!process.argv.includes('--navigate'))
  throw Error('Use --navigate to explicitly allow public-room traversal');
const roomsArg = process.argv.indexOf('--rooms');
const roomLimit = roomsArg >= 0 ? Number(process.argv[roomsArg + 1]) : 3;
if (!Number.isInteger(roomLimit) || roomLimit < 1 || roomLimit > 12)
  throw Error('Invalid room limit');
const dataDir = path.join(process.env.APPDATA || process.cwd(), 'shuangyu-assistant');
const store = createDataStore({ dataDir, persist: process.argv.includes('--persist') });
store.init();
const info = await manager.ensureClient();
const driver = new AndroidDriver({ adbOpts: { adbPath: info.adbPath, serial: info.serial } });
await driver.ensureReady();
await driver.bridge.ensureCompatible();
const first = await driver.bridge.dumpUi({ retries: 0 });
const { extractRoomUsers } = await import('../src/room-collector.mjs');
const passiveReal = new Set(extractRoomUsers(first.nodes).filter(u => u.uidReal).map(u => u.uid));
const verified = new Set(), controller = new AbortController();
let done;
const finished = new Promise(r => {
  done = r;
});
const timer = setTimeout(() => {
  controller.abort();
  done();
}, 45000);
const start = performance.now();
const collector = new RoomCollector(driver, { scope: 'multi', maxRooms: roomLimit, intervalMs: 1000, ...store.getCollectionCoverage(),
  onUsers: (users, meta) => {
    for (const u of users)
      if (u.uidReal)
        verified.add(u.uid);
    return store.ingestRealRecords(users, meta);
  },
  onLog: (level, message) => {
    if (level === 'warn')
      console.log('[warn]', message.replace(/:.*$/, ''));
  },
  onProgress: status => {
    if (status.rounds >= roomLimit) {
      controller.abort();
      done();
    }
  },
});
try {
  await collector.start({ signal: controller.signal });
  await finished;
  await collector.stop();
  const status = collector.getStatus();
  const result = { passiveSnapshotVerified: passiveReal.size, optimizedVerified: verified.size, elapsedMs: Math.round(performance.now() - start), ...status, persisted: process.argv.includes('--persist') };
  delete result.room;
  delete result.roomCode;
  fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'tmp', 'collection-benchmark.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
finally {
  clearTimeout(timer);
  controller.abort();
  await collector.stop();
  store.shutdown();
}
