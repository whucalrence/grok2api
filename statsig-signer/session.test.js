import test from "node:test";
import assert from "node:assert/strict";
import { inferAccountTier, isLoginURL } from "./session.js";

test("infers current Grok tiers from protected quota totals", () => {
  assert.equal(inferAccountTier([{ mode: "auto", total: 20 }, { mode: "fast", total: 30 }]), "basic");
  assert.equal(inferAccountTier([{ mode: "auto", total: 50 }, { mode: "fast", total: 140 }]), "super");
  assert.equal(inferAccountTier([{ mode: "auto", total: 150 }, { mode: "fast", total: 400 }]), "heavy");
});

test("uses the lower tier when protected quota signals conflict", () => {
  assert.equal(inferAccountTier([{ mode: "auto", total: 50 }, { mode: "fast", total: 30 }]), "basic");
  assert.equal(inferAccountTier([{ mode: "auto", total: 999 }]), "unknown");
});

test("detects login redirects and foreign origins", () => {
  assert.equal(isLoginURL("https://grok.com/", "https://grok.com"), false);
  assert.equal(isLoginURL("https://grok.com/sign-in", "https://grok.com"), true);
  assert.equal(isLoginURL("https://accounts.x.ai/auth", "https://grok.com"), true);
  assert.equal(isLoginURL("not-a-url", "https://grok.com"), true);
});
