'use strict';

/**
 * electron-builder `afterSign` hook: submit the signed app to Apple's notary
 * service, then staple the ticket to it.
 *
 * Two things about electron-builder 25 make this hook necessary rather than
 * just setting `mac.notarize`:
 *
 *  1. its built-in path only *submits* the app — it never staples the ticket,
 *     and an unstapled app still fails Gatekeeper for anyone offline;
 *  2. this hook runs after signing but before the DMG is built, so the DMG
 *     contains an app that is already notarised and stapled.
 *
 * electron-builder calls this after signing but also when signing was skipped
 * (no certificate), so the hook checks for the signature itself: Apple rejects
 * ad-hoc or unsigned submissions, and there is nothing to staple either. Both
 * of those cases warn and return rather than failing a build that simply has
 * no credentials configured.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { notarize } = require('@electron/notarize');

const exec = promisify(execFile);

/**
 * Notarisation credentials from the environment, or null when none are set.
 *
 * A partial configuration throws rather than silently skipping: a missing
 * APPLE_TEAM_ID would otherwise publish an unnotarised build that looks signed,
 * which is exactly the failure this is meant to prevent.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ appleId: string, appleIdPassword: string, teamId: string } | null}
 */
function resolveCredentials(env = process.env) {
  const values = {
    APPLE_ID: env.APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD: env.APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID: env.APPLE_TEAM_ID,
  };
  const set = Object.values(values).filter(Boolean);
  if (set.length === 0) return null;

  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `macOS notarisation needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID together; missing: ${missing.join(', ')}`
    );
  }

  return {
    appleId: values.APPLE_ID,
    appleIdPassword: values.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: values.APPLE_TEAM_ID,
  };
}

/**
 * Only a Developer ID signature can be notarised; an unsigned or ad-hoc build
 * is rejected by Apple before the upload finishes.
 *
 * @param {string} appPath
 */
async function hasDeveloperIdSignature(appPath) {
  try {
    // codesign writes its details to stderr, not stdout.
    const { stderr } = await exec('codesign', ['--display', '--verbose=4', appPath]);
    return /^Authority=Developer ID Application/m.test(stderr);
  } catch {
    return false;
  }
}

/**
 * @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context
 */
async function afterSign(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const credentials = resolveCredentials();

  if (!credentials) {
    console.log(
      '[notarize] No Apple credentials in the environment — skipping notarisation. ' +
        'Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to enable it.'
    );
    return;
  }

  if (!(await hasDeveloperIdSignature(appPath))) {
    console.log(
      `[notarize] ${path.basename(appPath)} is not signed with a Developer ID, so Apple would reject it — skipping notarisation.`
    );
    return;
  }

  console.log(`[notarize] submitting ${path.basename(appPath)} to Apple (usually 1-5 minutes)`);
  await notarize({ appPath, tool: 'notarytool', ...credentials });

  // The ticket lives on Apple's servers until it is stapled onto the bundle;
  // without this a first launch with no network is rejected by Gatekeeper.
  console.log('[notarize] notarised — stapling the ticket');
  await exec('xcrun', ['stapler', 'staple', appPath]);
  await exec('xcrun', ['stapler', 'validate', appPath]);
  console.log('[notarize] ticket stapled and validated');
}

module.exports = { afterSign, resolveCredentials, hasDeveloperIdSignature };
