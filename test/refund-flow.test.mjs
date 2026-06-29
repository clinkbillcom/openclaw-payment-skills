import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

const source = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8');

function extractRefundHandler(code) {
  const start = code.indexOf('async function handle_clink_refund(args) {');
  const end = code.indexOf('function buildRefundStatusNotification(data) {');
  return start >= 0 && end > start ? code.slice(start, end) : '';
}

test('clink_refund no longer auto-starts refund status poll fallback', () => {
  const refundHandler = extractRefundHandler(source);
  assert.ok(refundHandler.includes('async function handle_clink_refund(args) {'));
  assert.doesNotMatch(refundHandler, /ensureRequiredPollFallback\([\s\S]*['"]refund_status['"]/);
  assert.doesNotMatch(refundHandler, new RegExp('DIRECT_SEND_' + 'POLL_REQUIRED'));
});
