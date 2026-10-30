import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { createSettings } from '../src/settings.js';
import { createInjector, getInjectionSnapshot } from '../src/inject.js';
import { configureScene, mintTrustedScene, runWithTrustedScene, resetSceneStateForTests } from '../src/scene.js';

function fixture() {
  const store = createStore(':memory:');
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = new Map();
  let qq = null;
  const host = {
    reflect: { get: name => name === 'qq' ? qq : null },
    systemPrompt: { context: def => { contexts.set(def.name, def); return () => {} } },
  };
  createInjector(host, service, settings, { maxInjectedItems: 5, importanceThreshold: 3 });
  const render = (name, id, preset = 'amadeus-qq') => contexts.get(name).text({ agent: {
    session: { id, header: { agentPreset: preset }, snapshotEvents: () => [] },
  } });
  return { store, service, settings, render, setQQ(value) { qq = value } };
}

test('QQ prompt injection is empty without a trusted Host binding or strict Scene policy', () => {
  resetSceneStateForTests();
  const f = fixture();
  try {
    f.service.saveWithDedupe({ type: 'history', title: 'Private secret', content: 'Only for private context', importance: 5 });
    f.settings.setProfile('Owner private profile');
    for (const preset of ['amadeus-qq', 'amadeus-qq-search', 'amadeus-qq-media', 'amadeus-qq-media-search', 'amadeus-qq-owner']) {
      assert.equal(f.render('memory', 'qq-session', preset), '', preset);
      assert.equal(f.render('user-settings', 'qq-session', preset), '', preset);
    }
    assert.match(f.render('memory', 'ordinary-session', 'cordis'), /Private secret/);
    configureScene({ enabled: true, strictQQ: true });
    for (const preset of ['amadeus-qq', 'amadeus-qq-search', 'amadeus-qq-media', 'amadeus-qq-media-search', 'amadeus-qq-owner']) {
      assert.equal(f.render('memory', 'qq-session', preset), '', preset);
    }
    assert.equal(getInjectionSnapshot(), null);
  } finally { f.store.close(); resetSceneStateForTests(); }
});

test('QQ Host binding exposes only memories from the bound Scene', () => {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true });
  const f = fixture();
  try {
    const groupA = mintTrustedScene({ platform: 'qq', kind: 'group', id: '10001:20001', verified: true });
    const groupB = mintTrustedScene({ platform: 'qq', kind: 'group', id: '10001:20002', verified: true });
    runWithTrustedScene(groupA, () => f.service.saveWithDedupe({ type: 'history', title: 'A plan', content: 'A only', importance: 5 }));
    runWithTrustedScene(groupB, () => f.service.saveWithDedupe({ type: 'history', title: 'B secret', content: 'B only', importance: 5 }));
    f.setQQ({ resolveTrustedSessionScene(id) {
      if (id === 'session-a') return { platform: 'qq', kind: 'group', id: '10001:20001', verified: true, admin: false };
      throw new Error('QQ_UNAUTHORIZED');
    } });
    const text = f.render('memory', 'session-a');
    assert.match(text, /A plan/);
    assert.doesNotMatch(text, /B secret/);
    assert.equal(f.render('memory', 'retired-session'), '');
    assert.equal(f.render('user-settings', 'session-a'), '');
  } finally { f.store.close(); resetSceneStateForTests(); }
});

test('all packaged QQ presets keep the trusted Scene gate and suppress unscoped profile', () => {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true });
  const f = fixture();
  try {
    const groupA = mintTrustedScene({ platform: 'qq', kind: 'group', id: '10001:20001', verified: true });
    const groupB = mintTrustedScene({ platform: 'qq', kind: 'group', id: '10001:20002', verified: true });
    runWithTrustedScene(groupA, () => f.service.saveWithDedupe({ type: 'history', title: 'A plan', content: 'A only', importance: 5 }));
    runWithTrustedScene(groupB, () => f.service.saveWithDedupe({ type: 'history', title: 'B secret', content: 'B only', importance: 5 }));
    f.settings.setProfile('Private profile');
    f.setQQ({ resolveTrustedSessionScene(id) {
      if (id === 'session-a') return { platform: 'qq', kind: 'group', id: '10001:20001', verified: true, admin: false };
      throw new Error('QQ_UNAUTHORIZED');
    } });
    for (const preset of ['amadeus-qq', 'amadeus-qq-search', 'amadeus-qq-media', 'amadeus-qq-media-search', 'amadeus-qq-owner']) {
      const text = f.render('memory', 'session-a', preset);
      assert.match(text, /A plan/, preset);
      assert.doesNotMatch(text, /B secret/, preset);
      assert.equal(f.render('memory', 'retired-session', preset), '', preset);
      assert.equal(f.render('user-settings', 'session-a', preset), '', preset);
    }
  } finally { f.store.close(); resetSceneStateForTests(); }
});

test('custom QQ Preset needs a verified Host binding before memory injection', () => {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true });
  const f = fixture();
  try {
    f.service.saveWithDedupe({ type: 'history', title: 'Legacy secret', content: 'Unscoped data', importance: 5 });
    f.settings.setProfile('Private profile');
    assert.equal(f.render('memory', 'custom-session', 'renamed-qq-preset'), '');
    assert.equal(f.render('user-settings', 'custom-session', 'renamed-qq-preset'), '');

    const scene = mintTrustedScene({ platform: 'qq', kind: 'group', id: '10001:20001', verified: true });
    runWithTrustedScene(scene, () => f.service.saveWithDedupe({
      type: 'history', title: 'Group memory', content: 'Allowed data', importance: 5
    }));
    f.setQQ({ resolveTrustedSessionScene: () => ({
      platform: 'qq', kind: 'group', id: '10001:20001', verified: true
    }) });
    const text = f.render('memory', 'custom-session', 'renamed-qq-preset');
    assert.match(text, /Group memory/);
    assert.doesNotMatch(text, /Legacy secret/);
  } finally { f.store.close(); resetSceneStateForTests(); }
});
