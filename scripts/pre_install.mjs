#!/usr/bin/env node
/**
 * Pre-install script for agent-payment-skills.
 * No npm dependencies — only Node.js built-ins.
 *
 * Usage:
 *   node pre_install.mjs --channel feishu --target-id oc_xxx --target-type chat_id
 *   node pre_install.mjs --channel feishu --target-id ou_xxx --target-type open_id
 *   node pre_install.mjs --channel telegram --target-id 12345 --target-type target_id
 *
 * What it does (all in one):
 *   1. Registers the MCP server via npx mcporter --config <path> config add
 *   2. Stores notifyDestination in clink.config.json
 *   3. Schedules the gateway restart in the background
 *   4. Sends the install success notification immediately
 *
 * Async completion notifications are delivered by the mailbox event pump
 * (scripts/event-pump.mjs), started after wallet initialization — no webhook
 * route or hook transform is installed.
 *
 * After this script exits, the gateway restart is already scheduled in the background.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createMessageRequest } from '../notification-utils.js';

function resolveOpenClawHome() {
  const explicitHome = typeof process.env.OPENCLAW_HOME === 'string' ? process.env.OPENCLAW_HOME.trim() : '';
  if (explicitHome && explicitHome !== 'undefined') {
    return explicitHome;
  }
  return os.homedir();
}

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_HOME = resolveOpenClawHome();
const OPENCLAW_DIR = path.join(OPENCLAW_HOME, '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');
const MCPORTER_CONFIG_PATH = path.join(OPENCLAW_DIR, 'config', 'mcporter.json');
const BUNDLE = path.join(SKILL_DIR, 'index.bundle.mjs');
const MESSAGE_SENDER = path.join(SKILL_DIR, 'scripts', 'send-message.mjs');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');

function resolveOpenClawExecutable() {
  const explicit = typeof process.env.OPENCLAW_BIN === 'string' ? process.env.OPENCLAW_BIN.trim() : '';
  if (explicit && explicit !== 'undefined') {
    return explicit;
  }
  try {
    const resolved = execFileSync('which', ['openclaw'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return resolved || 'openclaw';
  } catch {
    return 'openclaw';
  }
}

function probeGatewayRuntimePid(openclawBin) {
  try {
    const out = execFileSync(openclawBin, ['gateway', 'status', '--require-rpc', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const parsed = JSON.parse(out);
    const pid = parsed?.service?.runtime?.pid;
    return typeof pid === 'number' || (typeof pid === 'string' && pid.trim())
      ? { pid: String(pid), error: '' }
      : { pid: null, error: 'gateway status did not include runtime pid' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err?.stderr === 'string'
        ? err.stderr.trim()
        : Buffer.isBuffer(err?.stderr)
          ? err.stderr.toString('utf8').trim()
          : '';
    const stdout =
      typeof err?.stdout === 'string'
        ? err.stdout.trim()
        : Buffer.isBuffer(err?.stdout)
          ? err.stdout.toString('utf8').trim()
          : '';
    return {
      pid: null,
      error: [message, stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout]
        .filter(Boolean)
        .join(' | '),
    };
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function logInstallError(message) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fs.appendFile(LOG_PATH, `[${new Date().toISOString()}] [pre-install] ${message}\n`);
  } catch {}
}

// --- Parse args ---
const args = process.argv.slice(2);

function parseNotifyDestination(argv) {
  let channel = '';
  let targetId = '';
  let targetType = '';
  let locale = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      continue;
    }
    if (arg === '--channel') {
      channel = value.trim().toLowerCase();
      i++;
      continue;
    }
    if (arg === '--target-id') {
      targetId = value.trim();
      i++;
      continue;
    }
    if (arg === '--target-type') {
      targetType = value.trim();
      i++;
      continue;
    }
    if (arg === '--locale') {
      locale = value.trim();
      i++;
      continue;
    }
  }

  if (!channel && !targetId && !targetType) {
    throw new Error('A notify target is required. Use --channel, --target-id, and --target-type.');
  }
  if (!channel || !targetId || !targetType) {
    throw new Error('--channel, --target-id, and --target-type must be provided together.');
  }
  if (channel === 'feishu' && targetType !== 'chat_id' && targetType !== 'open_id') {
    throw new Error('--target-type must be "chat_id" or "open_id" when --channel feishu is used.');
  }
  return {
    channel,
    target: { type: targetType, id: targetId },
    ...(locale ? { locale } : {}),
  };
}

function buildNotificationPayload(notifyDestination, notification) {
  const payload = {
    channel: notifyDestination.channel,
    target: {
      ...notifyDestination.target,
      ...(notifyDestination.locale ? { locale: notifyDestination.locale } : {}),
    },
    deliver: true,
  };
  const messageRequest = notification?.message_key ? notification : notification?.message;
  if (!messageRequest?.message_key) {
    throw new Error('message payload must include message_key');
  }
  payload.message_key = String(messageRequest.message_key).trim();
  payload.vars = JSON.parse(JSON.stringify(messageRequest.vars || {}));
  payload.locale = typeof messageRequest.locale === 'string' ? messageRequest.locale : 'auto';
  if (messageRequest.delivery_policy) {
    payload.delivery_policy = JSON.parse(JSON.stringify(messageRequest.delivery_policy));
  }
  return payload;
}

let notifyDestination;
try {
  notifyDestination = parseNotifyDestination(args);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// --- Step 1: Register MCP server ---
console.log('Step 1: Registering MCP server...');
try {
  execFileSync('npx', [
    'mcporter',
    '--config',
    MCPORTER_CONFIG_PATH,
    'config',
    'add',
    'agent-payment-skills',
    `node ${BUNDLE}`,
  ], { stdio: 'inherit' });
  console.log('  ✅ Registered via npx mcporter');
} catch (e2) {
  console.warn('  ⚠️  MCP registration skipped (will be active after gateway restart):', e2.message);
}

// --- Store notify destination in clink.config.json so the event pump can resolve the current target at runtime ---
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
try {
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8')); } catch {}
  cache.notifyDestination = notifyDestination;
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`  ✅ Saved notify target: ${notifyDestination.channel}/${notifyDestination.target.type}/${notifyDestination.target.id}`);
} catch (e) {
  console.warn('  ⚠️  Could not save notify destination to cache:', e.message);
}

// --- Step 2: Schedule background restart ---
console.log('Step 2: Scheduling gateway restart...');
const OPENCLAW_BIN = resolveOpenClawExecutable();
const restartChild = spawn('sh', ['-c', `sleep 3 && ${shellQuote(OPENCLAW_BIN)} gateway restart`], {
  detached: true,
  stdio: 'ignore',
});
restartChild.unref();
console.log('  ✅ Gateway restart scheduled');

// --- Step 3: Send install notification ---
console.log('Step 3: Sending install notification...');
try {
  const authPayload = buildNotificationPayload(notifyDestination, {
    message: createMessageRequest({
      messageKey: 'install.success',
      vars: {},
    }),
  });
  execFileSync(process.execPath, [MESSAGE_SENDER, '--payload', JSON.stringify(authPayload)], { stdio: 'inherit' });
  console.log('  ✅ Install notification sent');
} catch (e) {
  console.warn('  ⚠️  Could not send install notification:', e.message);
  await logInstallError(`install notification failed: ${e.message}`);
}

console.log('\nPre-install complete. Gateway restart has been scheduled automatically.');
