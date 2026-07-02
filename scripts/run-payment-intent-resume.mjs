import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : {};
  if (!normalized.pendingPaymentIntents || typeof normalized.pendingPaymentIntents !== 'object' || Array.isArray(normalized.pendingPaymentIntents)) {
    normalized.pendingPaymentIntents = {};
  }
  return normalized;
}

async function readCache() {
  try {
    return normalizeCache(JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeCache({});
    throw error;
  }
}

async function writeCache(cache) {
  await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fsp.writeFile(CACHE_PATH, JSON.stringify(normalizeCache(cache), null, 2), 'utf8');
}

async function appendLog(message) {
  try {
    await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fsp.appendFile(LOG_PATH, `${message}\n`, 'utf8');
  } catch {}
}

async function updatePaymentIntent(paymentIntentId, patch) {
  const cache = await readCache();
  const existing = cache.pendingPaymentIntents[paymentIntentId] || { paymentIntentId };
  cache.pendingPaymentIntents[paymentIntentId] = {
    ...existing,
    ...patch,
    paymentIntentId,
    updatedAt: new Date().toISOString(),
  };
  await writeCache(cache);
}

async function run() {
  const args = parseArgs(process.argv);
  const configPath = args['config-path'];
  const paymentIntentId = args['payment-intent-id'];
  const tool = args.tool || 'resume_pending_payment_intent';
  if (!configPath || !paymentIntentId) {
    throw new Error('config-path and payment-intent-id are required');
  }

  const prefix = `[${new Date().toISOString()}] [payment_intent_resume]`;
  await appendLog(`${prefix} start paymentIntentId=${paymentIntentId}`);
  await updatePaymentIntent(paymentIntentId, {
    resumeDispatchStatus: 'RUNNING',
    resumeRunnerStartedAt: new Date().toISOString(),
  });

  const logFd = fs.openSync(LOG_PATH, 'a');
  let closeResult = null;
  try {
    closeResult = await new Promise((resolve, reject) => {
      const child = spawn('npx', [
        'mcporter',
        '--config', configPath,
        'call',
        'agent-payment-skills',
        tool,
        '--args',
        JSON.stringify({ paymentIntentId }),
      ], { stdio: ['ignore', logFd, logFd] });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    try { fs.closeSync(logFd); } catch {}
  }

  await appendLog(`${prefix} exit_code=${closeResult.code === null ? 'null' : closeResult.code} signal=${closeResult.signal || 'none'}`);
  if (closeResult.code !== 0) {
    await updatePaymentIntent(paymentIntentId, {
      resumeDispatchStatus: 'FAILED',
      resumeDispatchFailedAt: new Date().toISOString(),
      resumeDispatchExitCode: closeResult.code === null ? null : String(closeResult.code),
      resumeDispatchSignal: closeResult.signal || null,
    });
    process.exit(closeResult.code || 1);
  }
}

run().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    const args = parseArgs(process.argv);
    if (args['payment-intent-id']) {
      await updatePaymentIntent(args['payment-intent-id'], {
        resumeDispatchStatus: 'FAILED',
        resumeDispatchFailedAt: new Date().toISOString(),
        resumeDispatchError: message,
      });
    }
  } catch {}
  await appendLog(`[${new Date().toISOString()}] [payment_intent_resume.runner] ${message}`);
  process.exit(1);
});
