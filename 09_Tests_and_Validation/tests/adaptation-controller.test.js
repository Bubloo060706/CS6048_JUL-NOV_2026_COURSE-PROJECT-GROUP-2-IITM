'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/adaptation-controller.js');

const bad = { rttMs: 320, rtcpFractionLostPct: 2, fps: 28, measuredBitrateKbps: 900, availableOutgoingBitrateKbps: 600 };
const good = { rttMs: 80, rtcpFractionLostPct: 0, fps: 30, measuredBitrateKbps: 700, availableOutgoingBitrateKbps: 1200 };

test('does not intervene on an isolated bad sample', () => {
    const c = create();
    const r = c.update(bad);
    assert.equal(r.state, 'NORMAL');
    assert.equal(r.targetKbps, null);
});

test('requires three consecutive degradation samples before intervention', () => {
    const c = create();
    c.update(bad); c.update(bad);
    const r = c.update(bad);
    assert.equal(r.state, 'ADAPTIVE');
    assert.ok(r.targetKbps > 0);
    assert.equal(r.changed, true);
});

test('a healthy sample breaks degradation persistence', () => {
    const c = create();
    c.update(bad); c.update(bad); c.update(good); c.update(bad);
    assert.equal(c.update(good).state, 'NORMAL');
});

test('waits for sustained recovery before increasing cap', () => {
    const c = create();
    c.update(bad); c.update(bad); c.update(bad);
    const first = c.update(good);
    assert.equal(first.state, 'RECOVERY');
    assert.equal(first.changed, false);
    for (let i = 0; i < 4; i++) c.update(good);
    const recovered = c.update(good);
    assert.equal(recovered.state, 'RECOVERY');
    assert.equal(recovered.changed, true);
    assert.ok(recovered.targetKbps > first.targetKbps);
});

test('restores original sender configuration after ten healthy samples', () => {
    const c = create();
    c.update(bad); c.update(bad); c.update(bad);
    for (let i = 0; i < 9; i++) c.update(good);
    const r = c.update(good);
    assert.equal(r.state, 'NORMAL');
    assert.equal(r.restoreOriginal, true);
    assert.equal(r.targetKbps, null);
});

test('does not interpret missing metrics as healthy or degraded', () => {
    const c = create();
    const r = c.update({ rttMs: null, fps: null, rtcpFractionLostPct: null, availableOutgoingBitrateKbps: null });
    assert.equal(r.state, 'NORMAL');
    assert.equal(r.targetKbps, null);
});

test('respects original sender maxBitrate when present', () => {
    const c = create();
    c.update(bad); c.update(bad);
    const r = c.update({ ...bad, originalMaxBitrateKbps: 300 });
    assert.ok(r.targetKbps <= 300);
});

test('reset clears state and counters', () => {
    const c = create();
    c.update(bad); c.update(bad); c.update(bad);
    c.reset();
    assert.equal(c.update(good).state, 'NORMAL');
});
