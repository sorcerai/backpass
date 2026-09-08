import test from "node:test";
import assert from "node:assert/strict";

import { redact } from "../src/redact.js";

// Synthetic stand-ins shaped like real provider keys. None are credentials.
// Regression basis: a live `sk-tinyfish-` key survived redact() and reached two
// submitted analysis prompts (.backpass/triage-redaction-check.json).
const TINYFISH = "sk-tinyfish-7k2m9x4q8w1e5r3t";
const OTHER_PROVIDER = "sk-northwind-3f6g8h2j4k9l1m5n7p9r2t4v"; // dashed tail, 33 chars

test("provider-prefixed tinyfish keys are redacted in prose and assignments", () => {
  const header = redact(`curl -H "X-API-Key: ${TINYFISH}"`);
  assert.ok(!header.includes(TINYFISH));
  assert.match(header, /\[redacted:TINYFISH_KEY\]/);

  const parenthesized = redact(`probed the API again (${TINYFISH}) and got a 429`);
  assert.ok(!parenthesized.includes(TINYFISH));
  assert.match(parenthesized, /\[redacted:TINYFISH_KEY\]/);

  const assignment = redact(`TINYFISH_TOKEN=${TINYFISH}`);
  assert.equal(assignment, "TINYFISH_TOKEN=[redacted:TINYFISH_KEY]");
});

test("the generic sk- net covers unknown providers whose keys contain dashes", () => {
  const out = redact(`retrying with ${OTHER_PROVIDER} shortly`);
  assert.ok(!out.includes(OTHER_PROVIDER));
  assert.match(out, /\[redacted:API_KEY\]/);
});

test("the generic sk- net still covers pure-alphanumeric keys", () => {
  const alnum = `sk-${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"}`;
  assert.match(redact(`token ${alnum} here`), /\[redacted:API_KEY\]/);
});

test("known provider labels keep their specific names after the widened tail class", () => {
  assert.match(redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), /\[redacted:ANTHROPIC_KEY\]/);
  assert.match(redact("key sk-proj-abcdefghijklmnopqrstuvwxyz"), /\[redacted:OPENAI_KEY\]/);
  assert.match(redact("key sk-or-v1-abcdefghijklmnopqrstuvwxyz"), /\[redacted:OPENROUTER_KEY\]/);
});

test("short non-secret sk- prose is not mangled by the wider tail class", () => {
  assert.equal(redact("see the sk-mvp-demo-key notes"), "see the sk-mvp-demo-key notes");
  assert.equal(redact("nothing sensitive here"), "nothing sensitive here");
});
