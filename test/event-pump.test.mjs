import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

const pumpSource = await fs.readFile(new URL('../scripts/event-pump.mjs', import.meta.url), 'utf8');

test('event pump long-polls the agent mailbox via the vendored clink-cli bundle', () => {
  // Drives the CLI: `clink-cli.bundle.mjs events poll ...`
  assert.match(pumpSource, /clink-cli\.bundle\.mjs/);
  assert.match(pumpSource, /CLI_BUNDLE\s*=\s*path\.join\(\s*SKILL_DIR,\s*'vendor',\s*'clink-cli',\s*'clink-cli\.bundle\.mjs'\s*\)/);
  assert.match(pumpSource, /'events',\s*'poll'/);
  assert.match(pumpSource, /spawn\(process\.execPath,\s*\[\s*[\s\S]*CLI_BUNDLE/);
});

test('event pump self-exits when wallet credentials are missing', () => {
  // No-creds self-exit guard at startup and inside the poll loop.
  assert.match(pumpSource, /customerAPIKey/);
  assert.match(pumpSource, /customerId/);
  assert.match(
    pumpSource,
    /if\s*\(\s*!\s*initialCache\.customerId\s*\|\|\s*!\s*initialCache\.customerAPIKey\s*\)/,
  );
  assert.match(pumpSource, /process\.exit\(0\)/);
  assert.match(pumpSource, /if\s*\(\s*!cache\.customerId\s*\|\|\s*!cache\.customerAPIKey\s*\)\s*\{\s*[\s\S]*return\s+'no_creds'/);
});

test('event pump is a singleton guarded by locks/event-pump.lock', () => {
  assert.match(pumpSource, /LOCK_PATH\s*=\s*path\.join\(\s*LOCK_DIR,\s*'event-pump\.lock'\s*\)/);
  assert.match(pumpSource, /acquireLock/);
  assert.match(pumpSource, /releaseLock/);
  // Another live pump holding the lock -> exit immediately.
  assert.match(pumpSource, /if\s*\(\s*!acquired\s*\)/);
});

test('event pump maps mailbox events to the same notification message keys as the old webhook', () => {
  // payment_method.added -> payment.method.bound_success
  assert.match(pumpSource, /case 'payment_method\.added'/);
  assert.match(pumpSource, /'payment\.method\.bound_success'/);

  // agent_order.succeeded -> payment.success (+ merchant confirmation handoff)
  assert.match(pumpSource, /case 'agent_order\.succeeded'/);
  assert.match(pumpSource, /'payment\.success'/);
  assert.match(pumpSource, /spawnMerchantConfirmation/);

  // risk_rule.updated -> risk_rule.updated
  assert.match(pumpSource, /case 'risk_rule\.updated'/);
  assert.match(pumpSource, /messageKey:\s*'risk_rule\.updated'/);

  // purchase instruction activation -> VIC registration complete
  assert.match(pumpSource, /case 'purchase_instruction\.activated'/);
  assert.match(pumpSource, /'payment\.vic_registration_complete'/);
});
