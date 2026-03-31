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
 *   5. Writes + spawns background notify process (polls for gateway, then sends post-restart notification)
 *   6. Sends the status notification
 *
 * After this script exits, the agent only needs to run: openclaw gateway restart
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

// --- Step 4: Write + spawn post-restart notify process ---
console.log('Step 4: Spawning post-restart notify process...');

let userEmail = '';
try {
  const cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  userEmail = cache?.email || '';
} catch {}

const notifyScriptPath = path.join(OPENCLAW_DIR, 'cache', 'clink_notify.mjs');
const OPENCLAW_BIN = resolveOpenClawExecutable();
const postRestartNotification = createNotification({
  title: '✅ Clink 支付组件已上线',
  theme: 'green',
  details: [
    ['Webhook 路由', '已就绪 ✓'],
    ['网关状态', '重启完毕 ✓'],
  ],
  paragraphs: [
    `最后一步：钱包初始化\n请直接回复您的邮箱地址完成绑定。${userEmail ? `\n\n如需继续使用之前的邮箱：\n\`\`\`\n${userEmail}\n\`\`\`` : ''}`,
  ],
});
const postRestartPayload = buildNotificationPayload(notifyDestination, { notification: postRestartNotification });

const notifyCode = `
import { execFileSync } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';

const openclawBin = ${JSON.stringify(OPENCLAW_BIN)};
const sendMessageScript = ${JSON.stringify(MESSAGE_SENDER)};
const payload = ${JSON.stringify(JSON.stringify(postRestartPayload))};
const logPath = ${JSON.stringify(path.join(SKILL_DIR, 'error.log'))};
const initialDelayMs = 1000;
const maxWaitForDownMs = 60000;
const maxWaitForUpMs = 120000;
const pollMs = 500;
const sendRetries = 3;
const sendRetryDelayMs = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function logLine(message) {
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, '[' + new Date().toISOString() + '] [restart-notify] ' + message + '\\n');
  } catch {}
}

function probeGatewayPid() {
  try {
    const out = execFileSync(openclawBin, ['gateway', 'status', '--require-rpc', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const parsed = JSON.parse(out);
    if (parsed && parsed.service && parsed.service.runtime && parsed.service.runtime.pid) {
      return { pid: parsed.service.runtime.pid, error: '' };
    }
    return { pid: null, error: 'gateway status did not include runtime pid' };
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

function formatExecError(err) {
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
  const status = typeof err?.status === 'number' ? 'status: ' + err.status : '';
  return [message, status, stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout]
    .filter(Boolean)
    .join(' | ');
}

async function waitForInitialPid(maxAttempts) {
  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    const { pid, error } = probeGatewayPid();
    if (pid) {
      return { pid, error: lastError };
    }
    if (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  return { pid: null, error: lastError };
}

await sleep(initialDelayMs);

const initialProbe = await waitForInitialPid(5);
const initialPid = initialProbe.pid;

if (!initialPid) {
  await logLine('rpc readiness probe did not return an initial PID; continuing without baseline.' + (initialProbe.error ? ' last_error=' + initialProbe.error : ''));
}

let waitedDown = 0;
if (initialPid) {
  let observedDown = false;
  let lastDownError = '';
  while (waitedDown <= maxWaitForDownMs) {
    const { pid, error } = probeGatewayPid();
    if (error) {
      lastDownError = error;
    }
    if (!pid || pid !== initialPid) {
      observedDown = true;
      break;
    }
    await sleep(pollMs);
    waitedDown += pollMs;
  }

  if (!observedDown) {
    await logLine('gateway down timeout after ' + maxWaitForDownMs + 'ms' + (lastDownError ? ' | last_error=' + lastDownError : ''));
    process.exit(1);
  }
}

let waitedUp = 0;
let restartedPid = null;
let lastUpError = '';
while (waitedUp <= maxWaitForUpMs) {
  const { pid, error } = probeGatewayPid();
  if (error) {
    lastUpError = error;
  }
  if (pid && (!initialPid || pid !== initialPid)) {
    restartedPid = pid;
    break;
  }
  await sleep(pollMs);
  waitedUp += pollMs;
}

if (!restartedPid) {
  await logLine('gateway up timeout after ' + maxWaitForUpMs + 'ms' + (lastUpError ? ' | rpc readiness failed: ' + lastUpError : ''));
  process.exit(1);
}

for (let attempt = 1; attempt <= sendRetries; attempt++) {
  try {
    execFileSync(process.execPath, [sendMessageScript, '--payload', payload], {
      stdio: 'pipe',
      timeout: 15000,
    });
    await logLine('post-restart notification sent on attempt ' + attempt + ' (down_wait=' + waitedDown + 'ms up_wait=' + waitedUp + 'ms)');
    process.exit(0);
  } catch (err) {
    await logLine('send-message failed on attempt ' + attempt + ': ' + formatExecError(err));
    if (attempt < sendRetries) {
      await sleep(sendRetryDelayMs);
    }
  }
}

process.exit(1);
`;

await fs.mkdir(path.dirname(notifyScriptPath), { recursive: true });
await fs.writeFile(notifyScriptPath, notifyCode, 'utf8');

const restartChild = spawn('sh', ['-c', `sleep 3 && ${shellQuote(OPENCLAW_BIN)} gateway restart`], {
  detached: true,
  stdio: 'ignore',
});
restartChild.unref();

const notifyChild = spawn(process.execPath, [notifyScriptPath], {
  detached: true,
  stdio: 'ignore',
});
notifyChild.unref();
console.log('  ✅ Notify process spawned');
console.log('  ✅ Gateway restart scheduled');

// --- Step 5: Send status notification ---
console.log('Step 5: Sending status notification...');
try {
  const authPayload = buildNotificationPayload(notifyDestination, {
    notification: createNotification({
      title: '🔌 安装 Clink Payment Skill',
      theme: 'blue',
      details: [
        ['注册 Webhook 回调路由', '已完成 ✓'],
        ['写入网关配置文件', '已完成 ✓'],
        ['重启网关进程', '正在重启…'],
      ],
      paragraphs: ['网关重启完成后将自动发送下一步提示。'],
    }),
  });
  execFileSync(process.execPath, [MESSAGE_SENDER, '--payload', JSON.stringify(authPayload)], { stdio: 'inherit' });
  console.log('  ✅ Status notification sent');
} catch (e) {
  console.warn('  ⚠️  Could not send status notification:', e.message);
}

console.log('\nPre-install complete. Gateway restart has been scheduled automatically.');
