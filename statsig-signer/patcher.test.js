import test from "node:test";
import assert from "node:assert/strict";
import { isValidStatsigID, patchStatsigChunk, prepareStatsigDocument } from "./patcher.js";

test("patchStatsigChunk exposes the current Turbopack wrapper", () => {
  const source =
    'const marker="x-statsig-id";async function dY(n,i){t=t||new Promise(t=>{e.A(4629918).then(e=>t(e.default()))});let o=await t;return await o(n,i)}e.s([],6224142);';
  const result = patchStatsigChunk(source);

  assert.equal(result.patched, true);
  assert.equal(result.functionName, "dY");
  assert.equal(result.loaderModuleID, "4629918");
  assert.match(result.source, /globalThis\.__grok2apiStatsigSign=dY;/);
});

test("patchStatsigChunk leaves unrelated chunks unchanged", () => {
  const source = 'const header="x-statsig-id";';
  assert.deepEqual(patchStatsigChunk(source), { patched: false, source });
});

test("validates decoded Statsig payload length", () => {
  assert.equal(isValidStatsigID(Buffer.alloc(70).toString("base64").replace(/=+$/, "")), true);
  assert.equal(isValidStatsigID(Buffer.alloc(69).toString("base64")), false);
  assert.equal(isValidStatsigID("not base64"), false);
});

test("replaces the Grok verification meta without rewriting the document", () => {
  const source = '<html><head><meta content="old-value" name="grok-site-verification"><title>Grok</title></head></html>';
  const result = prepareStatsigDocument(source, 'new&"<>value');

  assert.equal(result.found, true);
  assert.equal(result.metaContent, 'new&"<>value');
  assert.equal(
    result.source,
    '<html><head><meta content="new&amp;&quot;&lt;&gt;value" name="grok-site-verification"><title>Grok</title></head></html>',
  );
});

test("reads unicode-hyphen verification meta without changing the source", () => {
  const source = '<meta NAME="grok‑site‑verification" CONTENT="current-value">';
  assert.deepEqual(prepareStatsigDocument(source), {
    found: true,
    source,
    metaContent: "current-value",
  });
});

test("rejects documents without a usable verification meta", () => {
  const source = '<html><head><meta name="description" content="Grok"></head></html>';
  assert.deepEqual(prepareStatsigDocument(source, "new-value"), {
    found: false,
    source,
    metaContent: "",
  });
});
