'use strict';

const $ = id => document.getElementById(id);
const els = {
    room: $('room'),
    mode: $('mode'),
    sampleInterval: $('sampleInterval'),
    join: $('joinBtn'),
    call: $('callBtn'),
    hangup: $('hangupBtn'),
    stats: $('statsBtn'),
    download: $('downloadBtn'),
    status: $('status'),
    local: $('localVideo'),
    remote: $('remoteVideo'),
    log: $('log'),
    bitrate: $('bitrate'),
    fps: $('fps'),
    resolution: $('resolution'),
    loss: $('loss'),
    rtt: $('rtt'),
    jitter: $('jitter'),
    actions: $('actions')
};

let ws = null;
let pc = null;
let pendingIceCandidates = [];
let localStream = null;
let joined = false;
let logging = false;
let statsTimer = null;
let previousStats = null;
let csvRows = [];
let rawStatsLines = [];
let apiSnapshotLines = [];
let eventLines = [];
let adaptationActions = 0;
let lastAdaptAt = 0;
let adaptationController = null;
let originalVideoEncoding = null;
let adaptationSender = null;
let statsCollectionInFlight = false;
let sessionId = 0;
let runConfig = null;
let lastRunMode = 'session';
let lastRunId = 'session';
let autoRunStarted = false;
let autoCallStarted = false;
let autoStopTimer = null;
let autoRunIndex = 0;

const AUTO = (() => {
    const params = new URLSearchParams(location.search);
    const enabled = params.get('auto') === '1';
    const role = ['caller', 'answerer'].includes(params.get('role')) ? params.get('role') : 'answerer';
    const durationSeconds = Number(params.get('duration') || 60);
    const requestedRuns = Number(params.get('runs') || 1);
    const baseRunId = (params.get('runId') || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`).slice(0, 100);
    const runs = Number.isFinite(requestedRuns) ? Math.min(3, Math.max(1, Math.floor(requestedRuns))) : 1;
    return {
        enabled,
        baseRunId,
        runs,
        role,
        endpointRole: ['linux', 'windows'].includes(params.get('endpointRole')) ? params.get('endpointRole') : '',
        room: (params.get('room') || 'experiment-auto').trim().slice(0, 64) || 'experiment-auto',
        mode: params.get('mode') === 'adaptive' ? 'adaptive' : 'baseline',
        intervalMs: Math.min(10000, Math.max(500, Number(params.get('intervalMs') || 1000))),
        durationSeconds: Number.isFinite(durationSeconds) ? Math.min(7200, Math.max(10, durationSeconds)) : 60,
        runId: runs > 1 ? `${baseRunId}-B1` : baseRunId,
        scheduleIds: (params.get('scheduleIds') || '').split(',').filter(Boolean),
        pairIds: (params.get('pairIds') || '').split(',').filter(Boolean),
        scheduleId: (params.get('scheduleId') || '').slice(0, 100),
        pairId: (params.get('pairId') || '').slice(0, 100),
        experimentId: (params.get('experimentId') || '').slice(0, 100)
    };
})();

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CONTROLLER = window.WebRTCAdaptationController;

function recordEvent(event, details = {}) {
    eventLines.push(JSON.stringify({ timestamp: new Date().toISOString(), monotonicMs: performance.now(), event, runId: runConfig?.runId || AUTO.runId, endpointRole: runConfig?.endpointRole || AUTO.endpointRole || 'unassigned', ...details }));
}

function log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    els.log.textContent = `${line}\n${els.log.textContent}`.slice(0, 12000);
}

function status(message) {
    els.status.textContent = message;
    log(message);
}

function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        log(`Signaling message not sent (${message.type}): WebSocket is not open.`);
    }
}

function maybeAutoCall() {
    if (!AUTO.enabled || AUTO.role !== 'caller' || autoCallStarted || !joined || !ws) return;
    autoCallStarted = true;
    void startCall();
}

function startAutomatedRun() {
    AUTO.scheduleId = AUTO.scheduleIds[autoRunIndex] || AUTO.scheduleId;
    AUTO.pairId = AUTO.pairIds[autoRunIndex] || AUTO.pairId;
    els.mode.value = AUTO.mode;
    els.sampleInterval.value = String(AUTO.intervalMs);

    // Keep each run's events and measurements separate.
    eventLines.length = 0;

    void toggleLogging().then(() => {
        if (!logging) {
            log(`AUTOMATED RUN FAILED TO START: runId=${AUTO.runId}`);
            return;
        }

        const currentRunId = AUTO.runId;
        log(`AUTOMATED RUN STARTED: runId=${currentRunId}; run=${autoRunIndex + 1}/${AUTO.runs}; duration=${AUTO.durationSeconds}s`);

        autoStopTimer = setTimeout(async () => {
            if (logging) await stopLogging();

            // Export separate files plus the complete bundle.
            downloadCsv();
            downloadLines(rawStatsLines, 'raw-getstats');
            downloadLines(apiSnapshotLines, 'browser-api');
            downloadRunBundle();

            log(`AUTOMATED RUN FINISHED: runId=${currentRunId}; all downloads requested.`);

            if (autoRunIndex + 1 < AUTO.runs) {
                autoRunIndex += 1;
                AUTO.runId = `${AUTO.baseRunId}-B${autoRunIndex + 1}`;

                log(`PREPARING NEXT RUN: ${AUTO.runId}`);

                if (pc && pc.connectionState === 'connected') {
                    startAutomatedRun();
                } else {
                    log('NEXT RUN NOT STARTED: WebRTC connection is no longer connected.');
                }
            } else {
                log('ALL AUTOMATED BASELINE RUNS FINISHED.');
            }
        }, AUTO.durationSeconds * 1000);
    });
}

function maybeAutoStartLogging() {
    if (!AUTO.enabled || autoRunStarted || !pc || pc.connectionState !== 'connected') return;
    autoRunStarted = true;
    startAutomatedRun();
}

function setButtons() {
    els.call.disabled = !joined || !ws || ws.readyState !== WebSocket.OPEN || Boolean(pc && pc.connectionState === 'connected');
    els.hangup.disabled = !pc;
    els.stats.disabled = !pc || pc.connectionState === 'closed';
    els.join.disabled = joined;
    els.download.disabled = csvRows.length === 0;
    els.mode.disabled = logging;
    els.sampleInterval.disabled = logging;
}

async function ensureMedia() {
    if (localStream) return localStream;
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera/microphone access requires HTTPS or localhost and a supported browser.');
    }
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
        }
    });
    els.local.srcObject = localStream;
    return localStream;
}


async function ensureMedia() {
    if (localStream) return localStream;

    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires HTTPS or localhost and a supported browser.');
    }

    // Video is required for this experiment.
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
        }
    });

    els.local.srcObject = localStream;
    return localStream;
}
function createPeer() {
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = event => {
        if (event.candidate) send({ type: 'candidate', candidate: event.candidate });
    };
    pc.ontrack = event => {
        if (event.streams?.[0] && els.remote.srcObject !== event.streams[0]) {
            els.remote.srcObject = event.streams[0];
        }
    };
    pc.onconnectionstatechange = () => {
        if (pc) {
            status(`Peer connection: ${pc.connectionState}`);
            recordEvent('connection_state_change', { state: pc.connectionState });
            setButtons();
            maybeAutoStartLogging();
        }
    };
    pc.oniceconnectionstatechange = () => {
        if (pc) { log(`ICE state: ${pc.iceConnectionState}`); recordEvent('ice_connection_state_change', { state: pc.iceConnectionState }); }
    };
    pc.onsignalingstatechange = () => { if (pc) recordEvent('signaling_state_change', { state: pc.signalingState }); };
    pc.onicegatheringstatechange = () => { if (pc) recordEvent('ice_gathering_state_change', { state: pc.iceGatheringState }); };
    return pc;
}

async function flushPendingIceCandidates() {
    if (!pc || !pc.remoteDescription || pendingIceCandidates.length === 0) return;
    const queued = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const candidate of queued) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            log(`Could not add queued ICE candidate: ${error.message}`);
        }
    }
}

async function ensurePeer() {
    if (pc) return pc;
    await ensureMedia();
    createPeer();
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    setButtons();
    return pc;
}

async function joinRoom() {
    try {
        if (!('RTCPeerConnection' in window)) {
            throw new Error('This browser does not support RTCPeerConnection.');
        }
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        const room = els.room.value.trim() || 'experiment';
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${protocol}://${location.host}`);
        ws.onopen = () => send({ type: 'join', room });
        ws.onmessage = async event => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                log('Ignored malformed signaling message.');
                return;
            }
            try {
                if (msg.type === 'joined') {
                    joined = true;
                    status(`Joined room ${room}. Waiting for the other participant.`);
                    setButtons();
                    if (AUTO.enabled && msg.peers > 0) maybeAutoCall();
                } else if (msg.type === 'peer-joined') {
                    status('Peer joined. One participant should click Start / answer call.');
                    maybeAutoCall();
                } else if (msg.type === 'offer') {
                    await ensurePeer();
                    if (pc.signalingState !== 'stable') {
                        throw new Error(`Cannot accept offer while signaling state is ${pc.signalingState}.`);
                    }
                    await pc.setRemoteDescription(msg.description);
                    await flushPendingIceCandidates();
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    send({ type: 'answer', description: pc.localDescription });
                    status('Answer sent; connecting…');
                } else if (msg.type === 'answer') {
                    if (pc && pc.signalingState === 'have-local-offer') {
                        await pc.setRemoteDescription(msg.description);
                        await flushPendingIceCandidates();
                        status('Answer received; connecting…');
                    } else {
                        log(`Ignored answer in signaling state ${pc?.signalingState ?? 'no peer'}.`);
                    }
                } else if (msg.type === 'candidate') {
                    if (msg.candidate) {
                        if (pc && pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
                        else pendingIceCandidates.push(msg.candidate);
                    }
                } else if (msg.type === 'peer-left') {
                    status('The other participant left the room.');
                } else if (msg.type === 'error') {
                    status(msg.message || 'Signaling server reported an error.');
                }
            } catch (error) {
                status(`Signaling error: ${error.message}`);
            }
        };
        ws.onclose = () => {
            joined = false;
            status('Signaling connection closed.');
            setButtons();
        };
        ws.onerror = () => status('Could not connect to signaling server. Check the server and network.');
    } catch (error) {
        status(`Setup error: ${error.message}`);
    }
}

async function startCall() {
    try {
        if (!joined) throw new Error('Join a room before starting a call.');
        await ensurePeer();
        if (pc.signalingState !== 'stable') {
            status(`Connection is currently ${pc.signalingState}. Wait for negotiation to finish.`);
            return;
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'offer', description: pc.localDescription });
        status('Offer sent; waiting for answer…');
        setButtons();
    } catch (error) {
        status(`Could not start call: ${error.message}`);
    }
}

function stopLogging() {
    if (!logging) return Promise.resolve();
    recordEvent('measurement_stopped', { sampleCount: csvRows.length, rawStatsSnapshots: rawStatsLines.length });
    const restorePromise = runConfig?.mode === 'adaptive' ? restoreOriginalSenderEncoding('measurement stopped') : Promise.resolve();
    logging = false;
    sessionId++;
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    runConfig = null;
    els.stats.textContent = 'Start logging';
    setButtons();
    log('Statistics logging stopped.');
    return restorePromise;
}

async function hangup() {
    await stopLogging();
    if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.close();
        pc = null;
    }
    pendingIceCandidates = [];
    els.remote.srcObject = null;
    previousStats = null;
    setButtons();
    status('Call ended.');
}

function findVideoReport(reports, type, trackId = null) {
    const candidates = [...reports.values()].filter(report =>
        report.type === type && (report.kind === 'video' || report.mediaType === 'video')
    );
    if (trackId) {
        const exact = candidates.find(report => report.trackIdentifier === trackId);
        if (exact) return exact;
    }
    return candidates.length === 1 ? candidates[0] : candidates[0] || null;
}

function findSelectedCandidatePair(reports) {
    const all = [...reports.values()];
    for (const transport of all) {
        if (transport.type === 'transport' && transport.selectedCandidatePairId) {
            const selected = reports.get(transport.selectedCandidatePairId);
            if (selected) return selected;
        }
    }
    return all.find(report =>
        report.type === 'candidate-pair' &&
        report.state === 'succeeded' &&
        report.selected === true
    ) || all.find(report =>
        report.type === 'candidate-pair' &&
        report.state === 'succeeded' &&
        report.nominated === true
    ) || null;
}

function computeBitrate(outbound, nowMs) {
    if (!outbound || !Number.isFinite(outbound.bytesSent)) {
        previousStats = null;
        return null;
    }
    const statsTimestamp = Number.isFinite(outbound.timestamp) ? outbound.timestamp : nowMs;
    let bitrate = null;
    if (
        previousStats &&
        previousStats.outId === outbound.id &&
        outbound.bytesSent >= previousStats.bytesSent
    ) {
        const seconds = (statsTimestamp - previousStats.timestamp) / 1000;
        if (seconds > 0) {
            bitrate = ((outbound.bytesSent - previousStats.bytesSent) * 8 / seconds) / 1000;
        }
    }
    previousStats = {
        outId: outbound.id,
        bytesSent: outbound.bytesSent,
        timestamp: statsTimestamp
    };
    return Number.isFinite(bitrate) ? bitrate : null;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function buildStatsRow(outbound, inbound, remoteInbound, candidatePair, bitrate, mode) {
    return {
        timestamp: new Date().toISOString(),
        runId: runConfig?.runId || '',
        endpointRole: runConfig?.endpointRole || 'manual',
        browserUserAgent: runConfig?.userAgent || navigator.userAgent,
        experimentId: runConfig?.experimentId || '',
        pairId: runConfig?.pairId || '',
        scheduleId: runConfig?.scheduleId || '',
        mode,
        connectionState: pc?.connectionState ?? 'closed',
        bitrate_kbps: finiteOrNull(bitrate),
        fps: finiteOrNull(outbound?.framesPerSecond),
        width: finiteOrNull(outbound?.frameWidth),
        height: finiteOrNull(outbound?.frameHeight),
        packetsSent: finiteOrNull(outbound?.packetsSent),
        retransmittedPacketsSent: finiteOrNull(outbound?.retransmittedPacketsSent),
        framesEncoded: finiteOrNull(outbound?.framesEncoded),
        framesSent: finiteOrNull(outbound?.framesSent),
        qualityLimitationReason: outbound?.qualityLimitationReason ?? null,
        framesReceived: finiteOrNull(inbound?.framesReceived),
        framesDecoded: finiteOrNull(inbound?.framesDecoded),
        framesDropped: finiteOrNull(inbound?.framesDropped),
        freezeCount: finiteOrNull(inbound?.freezeCount),
        totalFreezesDuration_s: finiteOrNull(inbound?.totalFreezesDuration),
        jitterBufferDelay_s: finiteOrNull(inbound?.jitterBufferDelay),
        jitterBufferEmittedCount: finiteOrNull(inbound?.jitterBufferEmittedCount),
        inboundBytesReceived: finiteOrNull(inbound?.bytesReceived),
        inboundPacketsReceived: finiteOrNull(inbound?.packetsReceived),
        inboundPacketsLost: finiteOrNull(inbound?.packetsLost),
        codecId: outbound?.codecId ?? null,
        remotePacketsLost: finiteOrNull(remoteInbound?.packetsLost),
        rtcpFractionLost_pct: Number.isFinite(remoteInbound?.fractionLost)
            ? remoteInbound.fractionLost * 100
            : null,
        intervalPacketsLost: null,
        intervalPacketLoss_pct: null,
        jitter_ms: Number.isFinite(inbound?.jitter) ? inbound.jitter * 1000 : null,
        rtt_ms: Number.isFinite(candidatePair?.currentRoundTripTime)
            ? candidatePair.currentRoundTripTime * 1000
            : null,
        availableOutgoingBitrate_kbps: Number.isFinite(candidatePair?.availableOutgoingBitrate)
            ? candidatePair.availableOutgoingBitrate / 1000
            : null,
        configuredTarget_kbps: null,
        controllerTarget_kbps: null,
        maxBitrateParameterBeforeSet_kbps: null,
        maxBitrateParameterAfterSet_kbps: null,
        setParametersApplied: null,
        adaptationStatus: mode === 'adaptive' ? 'pending' : 'not_applicable',
        adaptationState: mode === 'adaptive' ? 'NORMAL' : null,
        adaptationReason: null,
        adaptationError: null,
        adaptationActions
    };
}

async function applyBaselineUncapped() {
    if (!pc) throw new Error('No peer connection exists.');
    const sender = pc.getSenders().find(item => item.track?.kind === 'video');
    if (!sender) throw new Error('No local video sender exists.');
    const params = sender.getParameters();
    if (!params.encodings?.length) throw new Error('Video sender has no encoding parameters.');
    if (params.encodings[0].maxBitrate == null) return;
    delete params.encodings[0].maxBitrate;
    await sender.setParameters(params);
    log('Baseline: removed the application maxBitrate cap; browser congestion control remains enabled.');
}

async function restoreOriginalSenderEncoding(reason = 'measurement stopped') {
    if (!adaptationSender || !originalVideoEncoding) return;
    try {
        const params = adaptationSender.getParameters();
        if (!params.encodings?.length) return;
        if (originalVideoEncoding.maxBitrate == null) delete params.encodings[0].maxBitrate;
        else params.encodings[0].maxBitrate = originalVideoEncoding.maxBitrate;
        await adaptationSender.setParameters(params);
        recordEvent('sender_configuration_restored', { reason, originalMaxBitrate_kbps: originalVideoEncoding.maxBitrate == null ? null : originalVideoEncoding.maxBitrate / 1000 });
        log('Adaptive controller: restored the sender maxBitrate setting present before the experiment.');
    } catch (error) {
        recordEvent('sender_configuration_restore_failed', { reason, error: error.message });
        log(`Warning: could not restore original sender parameters: ${error.message}`);
    } finally {
        adaptationSender = null;
        originalVideoEncoding = null;
        adaptationController = null;
    }
}

async function adapt(row) {
    if (!pc) {
        row.adaptationStatus = 'no_peer_connection';
        return;
    }
    const sender = pc.getSenders().find(item => item.track?.kind === 'video');
    if (!sender) {
        row.adaptationStatus = 'no_video_sender';
        return;
    }

    try {
        if (!adaptationController) {
            adaptationSender = sender;
            const initial = sender.getParameters();
            if (!initial.encodings?.length) {
                row.adaptationStatus = 'no_encoding';
                return;
            }
            originalVideoEncoding = { maxBitrate: initial.encodings[0].maxBitrate ?? null };
            adaptationController = CONTROLLER.create();
            recordEvent('controller_initialized', {
                controllerConfig: adaptationController.config,
                originalMaxBitrate_kbps: originalVideoEncoding.maxBitrate == null ? null : originalVideoEncoding.maxBitrate / 1000,
                controlParameter: 'RTCRtpEncodingParameters.maxBitrate'
            });
        }

        const params = sender.getParameters();
        if (!params.encodings?.length) {
            row.adaptationStatus = 'no_encoding';
            return;
        }
        const current = Number.isFinite(params.encodings[0].maxBitrate) ? params.encodings[0].maxBitrate / 1000 : null;
        row.maxBitrateParameterBeforeSet_kbps = current;

        const decision = adaptationController.update({
            measuredBitrateKbps: row.bitrate_kbps,
            availableOutgoingBitrateKbps: row.availableOutgoingBitrate_kbps,
            rttMs: row.rtt_ms,
            fps: row.fps,
            rtcpFractionLostPct: row.rtcpFractionLost_pct,
            originalMaxBitrateKbps: originalVideoEncoding.maxBitrate == null ? null : originalVideoEncoding.maxBitrate / 1000
        });
        row.controllerTarget_kbps = decision.targetKbps;
        row.adaptationReason = decision.reason;
        row.adaptationState = decision.state;
        row.maxBitrateParameterAfterSet_kbps = current;
        row.setParametersApplied = false;
        row.adaptationStatus = 'unchanged';

        if (decision.restoreOriginal) {
            if (originalVideoEncoding.maxBitrate == null) delete params.encodings[0].maxBitrate;
            else params.encodings[0].maxBitrate = originalVideoEncoding.maxBitrate;
            await sender.setParameters(params);
            row.maxBitrateParameterAfterSet_kbps = originalVideoEncoding.maxBitrate == null ? null : originalVideoEncoding.maxBitrate / 1000;
            row.setParametersApplied = true;
            row.adaptationStatus = 'restored';
            adaptationActions++;
            recordEvent('adaptation_restored', { reason: decision.reason, state: decision.state });
        } else if (decision.changed && decision.targetKbps != null) {
            const target = Math.round(decision.targetKbps);
            params.encodings[0].maxBitrate = target * 1000;
            await sender.setParameters(params);
            adaptationActions++;
            row.maxBitrateParameterAfterSet_kbps = target;
            row.setParametersApplied = true;
            row.adaptationStatus = 'applied';
            recordEvent('adaptation_applied', { targetKbps: target, reason: decision.reason, state: decision.state, previousMaxBitrateKbps: current, signals: decision.signals });
        } else {
            row.adaptationStatus = decision.state === 'NORMAL' ? 'native_gcc' : 'holding';
        }

        row.adaptationActions = adaptationActions;
        els.actions.textContent = String(adaptationActions);
        if (row.setParametersApplied) {
            log(`Controller ${decision.state}: ${decision.reason}; sender maxBitrate=${row.maxBitrateParameterAfterSet_kbps == null ? 'original/unset' : row.maxBitrateParameterAfterSet_kbps + ' kbps'}.`);
        }
    } catch (error) {
        row.adaptationStatus = 'rejected';
        row.setParametersApplied = false;
        row.adaptationError = error.message;
        recordEvent('adaptation_rejected', { error: error.message, reason: row.adaptationReason });
        log(`Adaptation rejected by browser: ${error.message}`);
    }
}

async function collectStats(sampleSession) {
    if (!pc || !logging || statsCollectionInFlight || sampleSession !== sessionId) return;
    statsCollectionInFlight = true;
    try {
        const report = await pc.getStats();
        if (!logging || sampleSession !== sessionId || !pc) return;
        const reports = new Map();
        const rawReport = [];
        report.forEach(item => {
            const plain = typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
            rawReport.push(plain);
            reports.set(item.id, item);
        });
        rawStatsLines.push(JSON.stringify({ timestamp: new Date().toISOString(), monotonicMs: performance.now(), runId: runConfig.runId, endpointRole: runConfig.endpointRole, mode: runConfig.mode, reports: rawReport }));

        const senderSnapshots = pc.getSenders().map(senderItem => {
            let parameters = null;
            try { parameters = senderItem.getParameters(); } catch (error) { recordEvent('sender_parameters_error', { message: error.message }); }
            return { trackKind: senderItem.track?.kind || null, trackId: senderItem.track?.id || null, parameters };
        });
        const receiverSnapshots = pc.getReceivers().map(receiverItem => {
            let parameters = null;
            try { parameters = receiverItem.getParameters(); } catch (error) { recordEvent('receiver_parameters_error', { message: error.message }); }
            return { trackKind: receiverItem.track?.kind || null, trackId: receiverItem.track?.id || null, parameters };
        });
        const trackSnapshots = (localStream?.getTracks?.() || []).map(track => {
            let settings = null, constraints = null, capabilities = null;
            try { settings = track.getSettings(); } catch {}
            try { constraints = track.getConstraints(); } catch {}
            try { capabilities = track.getCapabilities?.() || null; } catch {}
            return { kind: track.kind, readyState: track.readyState, enabled: track.enabled, muted: track.muted, settings, constraints, capabilities };
        });
        const pcConfiguration = pc.getConfiguration();
        const safeConfiguration = {
            bundlePolicy: pcConfiguration.bundlePolicy,
            rtcpMuxPolicy: pcConfiguration.rtcpMuxPolicy,
            iceTransportPolicy: pcConfiguration.iceTransportPolicy,
            iceCandidatePoolSize: pcConfiguration.iceCandidatePoolSize,
            iceServers: (pcConfiguration.iceServers || []).map(server => ({ urls: server.urls }))
        };
        apiSnapshotLines.push(JSON.stringify({ timestamp: new Date().toISOString(), monotonicMs: performance.now(), runId: runConfig.runId, endpointRole: runConfig.endpointRole, userAgent: navigator.userAgent, platform: navigator.platform, connection: navigator.connection ? { effectiveType: navigator.connection.effectiveType, downlink: navigator.connection.downlink, rtt: navigator.connection.rtt, saveData: navigator.connection.saveData } : null, peerConnection: { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, iceGatheringState: pc.iceGatheringState, signalingState: pc.signalingState, configuration: safeConfiguration }, senders: senderSnapshots, receivers: receiverSnapshots, localTracks: trackSnapshots }));

        const sender = pc.getSenders().find(item => item.track?.kind === 'video');
        const outbound = findVideoReport(reports, 'outbound-rtp', sender?.track?.id ?? null);
        const inbound = findVideoReport(reports, 'inbound-rtp');
        const remoteCandidates = [...reports.values()].filter(item =>
            item.type === 'remote-inbound-rtp' &&
            (item.kind === 'video' || item.mediaType === 'video')
        );
        const remoteInbound = outbound
            ? remoteCandidates.find(item => item.localId === outbound.id) ||
              (remoteCandidates.length === 1 && !remoteCandidates[0].localId
                  ? remoteCandidates[0]
                  : null)
            : null;
        const candidatePair = findSelectedCandidatePair(reports);
        const bitrate = computeBitrate(outbound, Date.now());
        const row = buildStatsRow(
            outbound, inbound, remoteInbound, candidatePair, bitrate, runConfig.mode
        );

        if (runConfig.mode === 'adaptive') await adapt(row);
        if (!logging || sampleSession !== sessionId) return;

        row.adaptationActions = adaptationActions;
        csvRows.push(row);
        els.download.disabled = false;
        enableExportButtons();
        els.bitrate.textContent = row.bitrate_kbps == null ? '—' : `${row.bitrate_kbps.toFixed(0)} kbps`;
        els.fps.textContent = row.fps == null ? '—' : `${row.fps.toFixed(1)} fps`;
        els.resolution.textContent = row.width && row.height ? `${row.width} × ${row.height}` : '—';
        els.loss.textContent = row.rtcpFractionLost_pct == null
            ? '—'
            : `${row.rtcpFractionLost_pct.toFixed(2)}% (RTCP)`;
        els.rtt.textContent = row.rtt_ms == null ? '—' : `${row.rtt_ms.toFixed(1)} ms`;
        els.jitter.textContent = row.jitter_ms == null ? '—' : `${row.jitter_ms.toFixed(1)} ms`;
        els.actions.textContent = String(adaptationActions);
    } catch (error) {
        if (logging && sampleSession === sessionId) {
            log(`Stats collection failed: ${error.message}`);
        }
    } finally {
        statsCollectionInFlight = false;
    }
}

async function toggleLogging() {
    if (logging) {
        await stopLogging();
        return;
    }
    if (!pc || pc.connectionState !== 'connected') {
        status('Connect both peers before starting a measurement run.');
        return;
    }

    try {
        const mode = els.mode.value;
        const intervalMs = Math.min(10000, Math.max(500, Number(els.sampleInterval.value) || 1000));

        if (mode === 'baseline') await applyBaselineUncapped();

        csvRows = [];
        rawStatsLines = [];
        apiSnapshotLines = [];
        adaptationActions = 0;
        lastAdaptAt = 0;
        previousStats = null;
        runConfig = { mode, intervalMs, runId: AUTO.enabled ? AUTO.runId : `manual-${Date.now()}`, endpointRole: AUTO.endpointRole || (AUTO.enabled ? AUTO.role : 'manual'), userAgent: navigator.userAgent, experimentId: AUTO.experimentId, pairId: AUTO.pairId, scheduleId: AUTO.scheduleId };
        recordEvent('measurement_started', { mode, intervalMs, experimentId: runConfig.experimentId, pairId: runConfig.pairId, scheduleId: runConfig.scheduleId });
        lastRunMode = mode;
        lastRunId = runConfig.runId;
        sessionId++;
        const thisSession = sessionId;
        logging = true;
        els.stats.textContent = 'Stop logging';
        setButtons();
        adaptationController = null;
        adaptationSender = null;
        originalVideoEncoding = null;
        log(`Statistics logging started; mode=${mode}; interval=${intervalMs}ms; adaptation=${mode === 'adaptive' ? 'automatic bounded controller' : 'native GCC baseline'}.`);
        void collectStats(thisSession);
        statsTimer = setInterval(() => void collectStats(thisSession), intervalMs);
    } catch (error) {
        logging = false;
        runConfig = null;
        setButtons();
        status(`Could not start logging: ${error.message}`);
    }
}

function downloadCsv() {
    if (!csvRows.length) return;
    const keys = Object.keys(csvRows[0]);
    const quote = value => {
        if (value == null) return '';
        const string = String(value);
        return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
    };
    const content = [
        keys.join(','),
        ...csvRows.map(row => keys.map(key => quote(row[key])).join(','))
    ].join('\r\n');
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `webrtc-${lastRunId}-${lastRunMode}-metrics.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function downloadLines(lines, suffix, mime = 'application/x-ndjson') {
    if (!lines.length) return;
    const blob = new Blob([lines.join('\n') + '\n'], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `webrtc-${lastRunId || AUTO.runId}-${suffix}.jsonl`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadRunBundle() {
    if (!csvRows.length && !rawStatsLines.length && !eventLines.length) return;
    const bundle = {
        schemaVersion: 2,
        runId: lastRunId,
        mode: lastRunMode,
        exportedAt: new Date().toISOString(),
        normalizedMetrics: csvRows,
        rawGetStatsSnapshots: rawStatsLines.map(line => JSON.parse(line)),
        browserApiSnapshots: apiSnapshotLines.map(line => JSON.parse(line)),
        events: eventLines.map(line => JSON.parse(line)),
        notes: [
            'Raw getStats reports are preserved as returned by this browser, subject to browser serialization.',
            'Unavailable browser fields are omitted; absence must not be interpreted as zero.',
            'RTT is selected ICE candidate-pair RTT, not one-way latency.',
            'RTCP fractionLost and cumulative packetsLost are not interval packet-loss percentages.'
        ]
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `webrtc-${lastRunId}-complete-run.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function addExportButtons() {
    const download = els.download;
    const add = (id, label, handler) => {
        if ($(id)) return;
        const button = document.createElement('button');
        button.id = id;
        button.textContent = label;
        button.disabled = true;
        button.addEventListener('click', handler);
        download.insertAdjacentElement('afterend', button);
        return button;
    };
    add('downloadRawStatsBtn', 'Download raw getStats JSONL', () => downloadLines(rawStatsLines, 'raw-stats'));
    add('downloadApiBtn', 'Download API snapshots JSONL', () => downloadLines(apiSnapshotLines, 'api-snapshots'));
    add('downloadEventsBtn', 'Download event log JSONL', () => downloadLines(eventLines, 'events'));
    add('downloadBundleBtn', 'Download complete run bundle', downloadRunBundle);
}

function enableExportButtons() {
    for (const id of ['downloadRawStatsBtn', 'downloadApiBtn', 'downloadEventsBtn', 'downloadBundleBtn']) {
        const button = $(id);
        if (button) button.disabled = false;
    }
}

addExportButtons();
els.join.addEventListener('click', joinRoom);
els.call.addEventListener('click', startCall);
els.hangup.addEventListener('click', () => void hangup());
els.stats.addEventListener('click', () => void toggleLogging());
els.download.addEventListener('click', downloadCsv);

window.addEventListener('beforeunload', () => {
    stopLogging();
    if (autoStopTimer) clearTimeout(autoStopTimer);
    if (ws) ws.close();
    if (pc) pc.close();
    if (localStream) localStream.getTracks().forEach(track => track.stop());
});

if (AUTO.enabled) {
    els.room.value = AUTO.room;
    els.mode.value = AUTO.mode;
    els.sampleInterval.value = String(AUTO.intervalMs);
    log(`Automated experiment mode configured: runId=${AUTO.runId}; role=${AUTO.role}; mode=${AUTO.mode}; duration=${AUTO.durationSeconds}s.`);
    // Joining prompts for camera/microphone permission; the browser may require user approval.
    void joinRoom();
}
