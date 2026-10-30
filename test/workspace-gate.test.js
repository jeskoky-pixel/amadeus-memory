import test from "node:test";
import assert from "node:assert/strict";
import { listWorkspaces, listWorkspaceSessionIds, checkWorkspaceAccess } from "../src/workspace-gate.js";

function workspace(id, title, sessionIds) {
  return { id, title, sessionIds };
}

function registryOf(workspaces) {
  return { list: () => workspaces };
}

function plainCtx(registry) {
  return { workspaceRegistry: registry };
}

function reflectCtx(services, seen = []) {
  return {
    reflect: {
      get(name) {
        seen.push(name);
        return services[name];
      }
    }
  };
}

function assertDenied(result, reason) {
  assert.deepEqual(result, { allowed: false, reason, workspaceId: null });
}

test("workspace-gate: list returns only validated id/title/sessionCount", () => {
  const raw = [
    {
      id: "ws-a",
      title: " Alpha ",
      sessionIds: ["s1", "s2", "s2"],
      directory: "C:\\secret-a",
      preset: "private-preset"
    },
    { id: "", title: "No id", sessionIds: [] },
    { id: "ws-b", title: "", sessionIds: [] },
    { id: "ws-c", title: "Gamma", sessionIds: ["s3", 7] }
  ];
  const seen = [];
  const ctx = reflectCtx({ workspaceRegistry: registryOf(raw) }, seen);

  assert.deepEqual(listWorkspaces(ctx), [
    { id: "ws-a", title: "Alpha", sessionCount: 2 },
    { id: "ws-b", title: "ws-b", sessionCount: 0 }
  ]);
  assert.deepEqual(seen, ["workspaceRegistry"], "Cordis must be read through reflect.get");
});

test("workspace-gate: plain mock ctx works and missing registry lists nothing", () => {
  const ctx = plainCtx(registryOf([workspace("ws-1", "One", ["s1"])]));
  assert.deepEqual(listWorkspaces(ctx), [
    { id: "ws-1", title: "One", sessionCount: 1 }
  ]);
  assert.deepEqual(listWorkspaces({}), []);
  assert.deepEqual(listWorkspaces({ reflect: { get: () => undefined } }), []);
});

test("workspace-gate: owner Session list uses exact selected Registry membership", () => {
  const ctx = plainCtx(registryOf([
    workspace("ws-a", "Same name", ["s1", "s2"]),
    workspace("ws-b", "Same name", ["s3"])
  ]));
  assert.deepEqual(listWorkspaceSessionIds(ctx, "ws-a"), {
    ok: true, reason: "ok", workspaceId: "ws-a", sessionIds: ["s1", "s2"]
  });
  assert.equal(listWorkspaceSessionIds(ctx, "Same name").reason, "workspace-not-found");
  assert.equal(listWorkspaceSessionIds(ctx, "ws-b").sessionIds[0], "s3");
  const ambiguous = plainCtx(registryOf([
    workspace("ws-a", "A", ["s1"]), workspace("ws-b", "B", ["s1"])
  ]));
  assert.equal(listWorkspaceSessionIds(ambiguous, "ws-a").reason, "ambiguous-membership");
  const malformed = plainCtx(registryOf([
    workspace("ws-a", "A", ["s1"]), workspace("ws-b", "B", [null])
  ]));
  assert.equal(listWorkspaceSessionIds(malformed, "ws-a").reason, "malformed-registry");
});

test("workspace-gate: selected workspace allows an exact stable session id", () => {
  const ctx = plainCtx(registryOf([
    workspace("ws-1", "Project", ["s1"]),
    workspace("ws-2", "Project", ["s2"])
  ]));

  assert.deepEqual(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx), {
    allowed: true,
    reason: "ok",
    workspaceId: "ws-1"
  });
});

test("workspace-gate: unselected workspace and same-title different ID deny", () => {
  const ctx = plainCtx(registryOf([
    workspace("ws-1", "Project", ["s1"]),
    workspace("ws-2", "Project", ["s2"])
  ]));

  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-2", ctx), "workspace-mismatch");
  assertDenied(checkWorkspaceAccess({ id: "s2" }, "ws-1", ctx), "workspace-mismatch");
});

test("workspace-gate: a newly added session takes effect on the next request", () => {
  let members = ["s1"];
  const ctx = plainCtx({ list: () => [workspace("ws-1", "One", members)] });

  assert.equal(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx).allowed, true);
  assertDenied(checkWorkspaceAccess({ id: "s2" }, "ws-1", ctx), "session-not-found");

  members = [...members, "s2"];
  assert.equal(checkWorkspaceAccess({ id: "s2" }, "ws-1", ctx).allowed, true);
});

test("workspace-gate: a moved session is denied by the old workspace and allowed by the new one", () => {
  let first = ["s1"];
  let second = [];
  const ctx = plainCtx({
    list: () => [
      workspace("ws-1", "One", first),
      workspace("ws-2", "Two", second)
    ]
  });

  assert.equal(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx).allowed, true);

  first = [];
  second = ["s1"];
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx), "workspace-mismatch");
  assert.equal(checkWorkspaceAccess({ id: "s1" }, "ws-2", ctx).allowed, true);
});

test("workspace-gate: forged session fields never authorize", () => {
  const ctx = plainCtx(registryOf([workspace("ws-1", "Project", ["s-real"])]));
  const forged = {
    id: "s-forged",
    title: "Project",
    workspaceId: "ws-1",
    workspaceTitle: "Project",
    directory: "C:\\ws-1",
    preset: "ws-1",
    header: { cwd: "C:\\ws-1", agentPreset: "ws-1" },
    caller: { workspaceId: "ws-1", title: "Project" },
    request: { workspaceId: "ws-1" }
  };

  assertDenied(checkWorkspaceAccess(forged, "ws-1", ctx), "session-not-found");
  assert.deepEqual(
    checkWorkspaceAccess(
      { id: "s-real", title: "Other", header: { cwd: "D:\\other" } },
      "ws-1",
      ctx
    ),
    { allowed: true, reason: "ok", workspaceId: "ws-1" },
    "only the real stable session id authorizes, not matching display fields"
  );
});

test("workspace-gate: authorization never reads forged session metadata", () => {
  const ctx = plainCtx(registryOf([workspace("ws-1", "Project", ["s1"])]));
  const session = {
    id: "s1",
    get title() { throw new Error("title must not be read"); },
    get directory() { throw new Error("directory must not be read"); },
    get preset() { throw new Error("preset must not be read"); },
    get header() { throw new Error("session header must not be read"); },
    get caller() { throw new Error("caller JSON must not be read"); }
  };

  assert.deepEqual(checkWorkspaceAccess(session, "ws-1", ctx), {
    allowed: true,
    reason: "ok",
    workspaceId: "ws-1"
  });
});

test("workspace-gate: a missing or throwing display title does not revoke stable membership", () => {
  const ctx = plainCtx(registryOf([
    { id: "ws-1", title: "", sessionIds: ["s1"] },
    { id: "ws-2", get title() { throw new Error("display unavailable"); }, sessionIds: ["s2"] }
  ]));
  assert.equal(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx).allowed, true);
  assert.equal(checkWorkspaceAccess({ id: "s2" }, "ws-2", ctx).allowed, true);
  assert.deepEqual(listWorkspaces(ctx), [
    { id: "ws-1", title: "ws-1", sessionCount: 1 },
    { id: "ws-2", title: "ws-2", sessionCount: 1 }
  ]);
});

test("workspace-gate: missing selected id, session id, or registry denies", () => {
  const ctx = plainCtx(registryOf([workspace("ws-1", "One", ["s1"])]));

  assertDenied(checkWorkspaceAccess({ id: "s1" }, undefined, ctx), "missing-workspace-id");
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "   ", ctx), "missing-workspace-id");
  assertDenied(checkWorkspaceAccess({}, "ws-1", ctx), "missing-session-id");
  assertDenied(checkWorkspaceAccess({ id: "" }, "ws-1", ctx), "missing-session-id");
  assertDenied(checkWorkspaceAccess(null, "ws-1", ctx), "missing-session-id");
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", {}), "registry-unavailable");
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", undefined), "registry-unavailable");
  assertDenied(
    checkWorkspaceAccess({ id: "s1" }, "ws-1", plainCtx(registryOf([]))),
    "session-not-found"
  );
});

test("workspace-gate: ambiguous membership denies", () => {
  const ctx = plainCtx(registryOf([
    workspace("ws-1", "One", ["s1"]),
    workspace("ws-2", "Two", ["s1"])
  ]));

  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx), "ambiguous-membership");
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-2", ctx), "ambiguous-membership");
});

test("workspace-gate: malformed registry data fails closed", () => {
  const malformedEntry = plainCtx(registryOf([
    workspace("ws-1", "One", ["s1"]),
    { id: "ws-bad", title: "Bad", sessionIds: "s1" }
  ]));
  assertDenied(
    checkWorkspaceAccess({ id: "s1" }, "ws-1", malformedEntry),
    "malformed-registry"
  );
  assert.deepEqual(listWorkspaces(malformedEntry), [
    { id: "ws-1", title: "One", sessionCount: 1 }
  ]);

  const notAList = plainCtx({ list: () => ({ id: "ws-1" }) });
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", notAList), "malformed-registry");
  assert.deepEqual(listWorkspaces(notAList), []);
});

test("workspace-gate: duplicate workspace IDs are ambiguous and omitted from the list", () => {
  const ctx = plainCtx(registryOf([
    workspace("ws-1", "One", ["s1"]),
    workspace("ws-1", "One duplicate", ["s2"])
  ]));

  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx), "ambiguous-registry");
  assert.deepEqual(listWorkspaces(ctx), []);
});

test("workspace-gate: registry exceptions and thrown accessors deny", () => {
  const throwingList = plainCtx({ list: () => { throw new Error("registry boom"); } });
  assertDenied(checkWorkspaceAccess({ id: "s1" }, "ws-1", throwingList), "registry-unavailable");
  assert.deepEqual(listWorkspaces(throwingList), []);

  const throwingReflect = {
    reflect: { get() { throw new Error("reflect boom"); } }
  };
  assertDenied(
    checkWorkspaceAccess({ id: "s1" }, "ws-1", throwingReflect),
    "registry-unavailable"
  );
  assert.deepEqual(listWorkspaces(throwingReflect), []);

  const throwingEntry = plainCtx({
    list: () => [{
      get id() { throw new Error("id boom"); },
      title: "One",
      sessionIds: ["s1"]
    }]
  });
  assertDenied(
    checkWorkspaceAccess({ id: "s1" }, "ws-1", throwingEntry),
    "malformed-registry"
  );
  assert.deepEqual(listWorkspaces(throwingEntry), []);

  const throwingSession = {
    get id() { throw new Error("session boom"); }
  };
  assertDenied(
    checkWorkspaceAccess(throwingSession, "ws-1", plainCtx(registryOf([]))),
    "missing-session-id"
  );
});

test("workspace-gate: reads have no side effects on registry data", () => {
  const raw = Object.freeze([
    Object.freeze({ id: "ws-1", title: "One", sessionIds: Object.freeze(["s1"]) })
  ]);
  const ctx = Object.freeze({
    workspaceRegistry: Object.freeze({ list: () => raw })
  });

  assert.deepEqual(listWorkspaces(ctx), [
    { id: "ws-1", title: "One", sessionCount: 1 }
  ]);
  assert.equal(checkWorkspaceAccess({ id: "s1" }, "ws-1", ctx).allowed, true);
  assert.deepEqual(raw, [
    { id: "ws-1", title: "One", sessionIds: ["s1"] }
  ]);
});
