(function exposeAdaptationController(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.WebRTCAdaptationController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAdaptationController() {
    'use strict';

    const DEFAULTS = Object.freeze({
        rttHighMs: 200,
        lossHighPct: 1.0,
        fpsLow: 20,
        persistenceSamples: 3,
        recoverySamples: 5,
        fullRecoverySamples: 10,
        reductionFactor: 0.92,
        recoveryStepFactor: 1.25,
        minimumCapKbps: 150
    });

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function create(options = {}) {
        const config = { ...DEFAULTS, ...options };
        let badSamples = 0;
        let goodSamples = 0;
        let active = false;
        let lastTargetKbps = null;
        let state = 'NORMAL';

        function update(input = {}) {
            const rtt = finite(input.rttMs) && input.rttMs >= 0 ? input.rttMs : null;
            const loss = finite(input.rtcpFractionLostPct) && input.rtcpFractionLostPct >= 0 ? input.rtcpFractionLostPct : null;
            const fps = finite(input.fps) && input.fps >= 0 ? input.fps : null;
            const bitrate = finite(input.measuredBitrateKbps) && input.measuredBitrateKbps > 0 ? input.measuredBitrateKbps : null;
            const available = finite(input.availableOutgoingBitrateKbps) && input.availableOutgoingBitrateKbps > 0 ? input.availableOutgoingBitrateKbps : null;
            const original = finite(input.originalMaxBitrateKbps) && input.originalMaxBitrateKbps > 0 ? input.originalMaxBitrateKbps : null;

            const signals = {
                highRtt: rtt !== null && rtt >= config.rttHighMs,
                highLoss: loss !== null && loss >= config.lossHighPct,
                lowFps: fps !== null && fps < config.fpsLow,
                constrainedEstimate: available !== null && bitrate !== null && available < bitrate * 0.80
            };
            const hasSignal = Object.values(signals).some(Boolean);
            // Require at least one usable network/quality signal; missing data is not a healthy sample.
            const hasUsableSignal = rtt !== null || loss !== null || fps !== null || available !== null;

            if (hasSignal) {
                badSamples += 1;
                goodSamples = 0;
            } else if (hasUsableSignal) {
                goodSamples += 1;
                badSamples = 0;
            } else {
                badSamples = 0;
                goodSamples = 0;
            }

            if (!active && badSamples >= config.persistenceSamples) {
                active = true;
                state = 'ADAPTIVE';
            }

            if (!active) {
                return { state: 'NORMAL', targetKbps: null, restoreOriginal: false, changed: false, reason: 'native GCC; no persistent degradation', signals, badSamples, goodSamples };
            }

            if (hasSignal) {
                state = 'ADAPTIVE';
                const capacity = available !== null ? available : bitrate;
                let target = capacity !== null ? capacity * config.reductionFactor : (lastTargetKbps || 1000) * config.reductionFactor;
                if (original !== null) target = Math.min(target, original);
                target = Math.max(config.minimumCapKbps, Math.round(target));
                if (lastTargetKbps !== null) target = Math.min(target, lastTargetKbps);
                const changed = lastTargetKbps === null || Math.abs(target - lastTargetKbps) >= Math.max(50, lastTargetKbps * 0.10);
                if (changed) lastTargetKbps = target;
                return { state, targetKbps: lastTargetKbps, restoreOriginal: false, changed, reason: 'persistent network/video degradation', signals, badSamples, goodSamples };
            }

            if (goodSamples >= config.fullRecoverySamples) {
                active = false;
                state = 'NORMAL';
                lastTargetKbps = null;
                return { state, targetKbps: null, restoreOriginal: true, changed: true, reason: 'sustained recovery; restore original sender configuration', signals, badSamples, goodSamples };
            }

            state = 'RECOVERY';
            if (goodSamples >= config.recoverySamples && lastTargetKbps !== null) {
                const ceiling = original;
                let next = Math.round(lastTargetKbps * config.recoveryStepFactor);
                if (ceiling !== null) next = Math.min(next, ceiling);
                const recoveredCapacity = available !== null ? available * config.reductionFactor : null;
                if (recoveredCapacity !== null) next = Math.min(next, Math.round(recoveredCapacity));
                if (next > lastTargetKbps + Math.max(50, lastTargetKbps * 0.10)) {
                    lastTargetKbps = next;
                    return { state, targetKbps: next, restoreOriginal: false, changed: true, reason: 'gradual recovery', signals, badSamples, goodSamples };
                }
            }
            return { state, targetKbps: lastTargetKbps, restoreOriginal: false, changed: false, reason: 'waiting for sustained recovery', signals, badSamples, goodSamples };
        }

        function reset() {
            badSamples = 0;
            goodSamples = 0;
            active = false;
            lastTargetKbps = null;
            state = 'NORMAL';
        }

        return { update, reset, config: { ...config } };
    }

    return { create, defaults: DEFAULTS };
});
