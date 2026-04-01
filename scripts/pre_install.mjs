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
 *   3. Copies hooks/my_payment_webhook.js → ~/.openclaw/hooks/transforms/
 *   4. Injects webhook mapping into ~/.openclaw/openclaw.json and verifies
 *   5. Schedules the gateway restart in the background
 *   6. Sends the install success notification immediately
 *
 * After this script exits, the gateway restart is already scheduled in the background.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createNotification } from '../notification-utils.js';

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
  };
}

function buildNotificationPayload(notifyDestination, notification) {
  const payload = {
    channel: notifyDestination.channel,
    target: notifyDestination.target,
    deliver: true,
  };
  if (notification?.notification && typeof notification.notification === 'object' && !Array.isArray(notification.notification)) {
    payload.notification = JSON.parse(JSON.stringify(notification.notification));
  }
  if (notification?.card) {
    payload.card = notification.card;
  }
  if (typeof notification?.text === 'string' && notification.text.trim()) {
    payload.text = notification.text.trim();
  }
  return payload;
}

async function renderWebhookModule(skillDir) {
  const webhookTemplatePath = path.join(skillDir, 'hooks', 'my_payment_webhook.js');
  const webhookSource = await fs.readFile(webhookTemplatePath, 'utf8');
  return webhookSource.split('__AGENT_PAYMENT_SKILL_DIR__').join(JSON.stringify(skillDir));
}

let notifyDestination;
try {
  notifyDestination = parseNotifyDestination(args);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// --- Helpers ---
async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
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

// --- Store notify destination in clink.config.json so webhook can resolve the current target at runtime ---
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

// --- Step 2: Copy webhook file ---
console.log('Step 2: Installing webhook transform...');
const webhookDst = path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.js');
await fs.mkdir(path.dirname(webhookDst), { recursive: true });
await fs.writeFile(webhookDst, await renderWebhookModule(SKILL_DIR), 'utf8');
console.log('  ✅ Webhook copied');

// --- Step 3: Inject config ---
console.log('Step 3: Updating openclaw.json...');
const config = await loadConfig();
config.hooks = config.hooks || {};
config.hooks.enabled = true;
config.hooks.mappings = config.hooks.mappings || [];
if (!config.hooks.token) {
  config.hooks.token = crypto.randomBytes(32).toString('hex');
}
const CLINK_PATH = '/clink/payment';
if (!config.hooks.mappings.some(m => m.transform?.module === 'my_payment_webhook.js')) {
  config.hooks.mappings.push({ match: { path: CLINK_PATH }, transform: { module: 'my_payment_webhook.js' } });
}
await saveConfig(config);

// Verify the write actually landed
const verify = await loadConfig();
const routeOk = verify.hooks?.mappings?.some(m => m.transform?.module === 'my_payment_webhook.js');
const webhookFileOk = await fs.access(webhookDst).then(() => true).catch(() => false);
if (!routeOk) {
  console.error('  ❌ Verification failed: webhook route not found in openclaw.json after write');
  process.exit(1);
}
if (!webhookFileOk) {
  console.error('  ❌ Verification failed: webhook file not found at', webhookDst);
  process.exit(1);
}
console.log('  ✅ Config updated and verified');
console.log('  ✅ Webhook route:', CLINK_PATH, '→ my_payment_webhook.js');

// --- Step 4: Schedule background restart ---
console.log('Step 4: Scheduling gateway restart...');
const OPENCLAW_BIN = resolveOpenClawExecutable();
const restartChild = spawn('sh', ['-c', `sleep 3 && ${shellQuote(OPENCLAW_BIN)} gateway restart`], {
  detached: true,
  stdio: 'ignore',
});
restartChild.unref();
console.log('  ✅ Gateway restart scheduled');

// --- Step 5: Send install notification ---
console.log('Step 5: Sending install notification...');
try {
  const authPayload = buildNotificationPayload(notifyDestination, {
    notification: createNotification({
      title: '✅ Clink Payment Skill 安装成功',
      theme: 'green',
      details: [
        ['Webhook 路由', '已就绪 ✓'],
        ['网关重启', '后台处理中 ✓'],
      ],
      paragraphs: ['请直接回复您的邮箱地址完成钱包初始化。若网关仍在重启中，稍候几秒后重试即可。'],
    }),
  });
  execFileSync(process.execPath, [MESSAGE_SENDER, '--payload', JSON.stringify(authPayload)], { stdio: 'inherit' });
  console.log('  ✅ Install notification sent');
} catch (e) {
  console.warn('  ⚠️  Could not send install notification:', e.message);
  await logInstallError(`install notification failed: ${e.message}`);
}

console.log('\nPre-install complete. Gateway restart has been scheduled automatically.');
