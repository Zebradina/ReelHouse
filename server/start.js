'use strict';

/**
 * Standalone server entry point: `npm start`.
 * The Electron desktop app boots the same service in-process.
 */
const os = require('os');
const { start } = require('./index');
const { DIRS, APP_NAME } = require('./config');

(async () => {
  try {
    const instance = await start();
    const line = '─'.repeat(52);
    console.log(`\n  ${APP_NAME}`);
    console.log(`  ${line}`);
    console.log(`  Web app   ${instance.url}`);
    if (instance.lanUrls && instance.lanUrls.length) {
      console.log(`  On your network  ${instance.lanUrls.join(', ')}`);
    } else {
      console.log('  On your network  off — enable it in Settings → Devices');
    }
    console.log(`  Data      ${DIRS.data}`);
    console.log(`  Library   ${instance.library.data.counts ? JSON.stringify(instance.library.data.counts) : 'not scanned'}`);
    console.log(`  ${line}`);
    console.log('  Press Ctrl+C to stop.\n');

    if (process.env.OPEN_BROWSER === '1') {
      const { exec } = require('child_process');
      const cmd =
        process.platform === 'darwin' ? `open "${instance.url}"`
        : process.platform === 'win32' ? `start "" "${instance.url}"`
        : `xdg-open "${instance.url}"`;
      exec(cmd, () => {});
    }

    const shutdown = () => {
      console.log('\n  Shutting down…');
      instance.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(`\n  ${APP_NAME} failed to start:`, err.message);
    console.error(`  Host: ${os.hostname()}`);
    process.exit(1);
  }
})();
