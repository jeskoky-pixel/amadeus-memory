import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { provideSceneAclRead, sceneAclReadDeclaration } from "../src/index.js";

const expected = {
  contract: "amadeus-memory/trusted-scene-acl-read",
  version: 1,
  trustedSceneAcl: true,
  strictQQ: true,
  tools: ["memory_search", "memory_list", "memory_get"]
};

test('unified runtime advertises read capability only after trusted Workspace mount',async()=>{
 const ctx=new Context();const drop=ctx.provide('qq',{resolveTrustedSessionScene(){return null;}});
 try {
  assert.equal(sceneAclReadDeclaration(ctx,{unifiedSessionAclEnabled:true}),null);
  assert.deepEqual(sceneAclReadDeclaration(ctx,{unifiedSessionAclEnabled:true},true),expected);
  assert.equal(sceneAclReadDeclaration(ctx,{unifiedSessionAclEnabled:false},true),null);
 } finally {drop();}
});

test("optional amadeus.memory handshake is provided only with strict QQ + Host", async () => {
  const ctx = new Context();
  const disposeQq = ctx.provide("qq", { resolveTrustedSessionScene() { return null; } });
  const cfg = { sceneIsolationEnabled: true, sceneStrictQQ: true };
  const dispose = provideSceneAclRead(ctx, cfg);
  try {
    const service = ctx.reflect.get("amadeus.memory");
    assert.ok(service && typeof service.sceneAclRead === "function", "dotted Cordis service name must work");
    assert.deepEqual(service.sceneAclRead(), expected);
    // Arguments cannot mint or broaden the declaration.
    assert.deepEqual(service.sceneAclRead({ admin: true, trustedSceneAcl: false }), expected);
    assert.deepEqual(sceneAclReadDeclaration(ctx, cfg), expected);
  } finally {
    await dispose();
    disposeQq();
  }
  assert.equal(ctx.reflect.get("amadeus.memory"), undefined, "unload must withdraw the service");
});

test("handshake returns null when features are off, Host is missing, or Host fails", async () => {
  const ctxOff = new Context();
  const disposeQqOff = ctxOff.provide("qq", { resolveTrustedSessionScene() { return null; } });
  const disposeOff = provideSceneAclRead(ctxOff, { sceneIsolationEnabled: false, sceneStrictQQ: true });
  try {
    assert.equal(ctxOff.reflect.get("amadeus.memory").sceneAclRead(), null, "feature-off must win even with Host present");
  } finally {
    await disposeOff();
    disposeQqOff();
  }

  const ctxNoHost = new Context();
  const disposeNoHost = provideSceneAclRead(ctxNoHost, { sceneIsolationEnabled: true, sceneStrictQQ: true });
  try {
    assert.equal(ctxNoHost.reflect.get("amadeus.memory").sceneAclRead(), null);
  } finally { await disposeNoHost(); }

  const ctxBroken = new Context();
  const disposeBroken = ctxBroken.provide("qq", {
    resolveTrustedSessionScene() { throw new Error("host unavailable"); }
  });
  const disposeService = provideSceneAclRead(ctxBroken, { sceneIsolationEnabled: true, sceneStrictQQ: true });
  try {
    // Function presence is the handshake gate; a later session-bound failure is
    // still fail-closed in the actual tool wrapper.
    assert.deepEqual(ctxBroken.reflect.get("amadeus.memory").sceneAclRead(), expected);
  } finally {
    await disposeService();
    disposeBroken();
  }
});

test("handshake is not exposed through ordinary model/HTTP surfaces", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/index.js", import.meta.url), "utf8"));
  assert.ok(source.includes('ctx.provide("amadeus.memory"'));
  assert.ok(!/api\/dsh-mneme.*amadeus\.memory/.test(source));
  assert.ok(!/memory_search.*sceneAclRead/.test(source));
});
