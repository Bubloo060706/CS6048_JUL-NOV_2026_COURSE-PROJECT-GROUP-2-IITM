# Code review notes

## Status

The uploaded project was audited as a whole and updated in this review package. Automated checks passed in the review environment. The browser-to-browser media path and real Linux `tc` impairment still require validation on the actual lab machines.

## Important findings addressed

1. **Loss metrics were conflated.** Earlier code copied `remote-inbound-rtp.fractionLost` into a field named `intervalPacketLoss_pct`. These are not the same measurement. The new CSV has `rtcpFractionLost_pct`; interval packet loss fields remain blank unless a valid paired receiver counter calculation is available.
2. **Receiver packet counters were assumed.** Standard remote-inbound WebRTC stats do not guarantee a `packetsReceived` field. The new implementation does not rely on it to calculate interval loss.
3. **The logging session inherited stale state.** A new session now resets bitrate sampling and adaptation action state.
4. **Stats collection could overlap.** A single-flight guard prevents overlapping asynchronous `getStats()` / adaptation cycles.
5. **CSV fields could vary by row.** The new implementation uses a stable row schema, with explicit status, parameter-before/after, and error fields.
6. **Requested cap could be confused with measured bitrate.** The CSV distinguishes `bitrate_kbps` from the sender `maxBitrate` parameter requested/accepted by `setParameters`.
7. **Baseline could retain an earlier adaptive cap.** Starting a baseline logging session removes the application cap when one is present. If the browser rejects that reset, logging does not silently proceed as an uncapped baseline.
8. **Selected candidate-pair lookup was loose.** Statistics now prefer the candidate pair referenced by the selected transport, then use a nominated/succeeded fallback.
9. **Signaling/static server handling needed defensive checks.** The HTTP handler now limits methods, catches malformed URLs, checks resolved paths, and adds basic response hardening. Signaling only forwards expected offer/answer/candidate message types and handles room changes more safely.
10. **Analysis could misrepresent old CSVs.** The analysis script now handles legacy field names and deliberately invalidates the legacy interval-loss column where older exports had incorrectly stored RTCP fraction loss there.
11. **Network impairment could be applied to the wrong path.** README explicitly states that same-machine browser tabs and a signaling server's unrelated interface do not establish a meaningful impaired-media experiment.
12. **Repeated runs required too much manual UI interaction.** Added opt-in URL automation for joining a room, caller-side offer initiation, mode/target/sample-interval configuration, timed logging stop, CSV download request, and run/endpoint/browser metadata in the CSV. It intentionally does not pretend to remotely control the second endpoint or verify `tc` routing.
13. **ICE candidates could arrive before peer creation or the remote description.** Candidates are now queued even if camera initialization has not yet created the peer connection, then flushed after `setRemoteDescription`; this reduces a common signaling race during offer/answer negotiation.
14. **The protocol needed a reproducible randomized run plan.** Added a protocol document, pilot matrix JSON, and deterministic seeded trial-plan generator that randomizes profile order and baseline/adaptive order within matched pairs.

## Validation completed

- `node --check public/adaptation-controller.js` — passed
- `node --check public/app.js` — passed
- `node --check server.js` — passed
- `npm test` — 9 controller unit tests passed
- `python -m py_compile analysis/analyze.py` — passed
- `bash -n scripts/netem_apply.sh` — passed
- `bash -n scripts/netem_clear.sh` — passed
- Python analysis smoke-tested against a synthetic CSV with missing first-sample bitrate; summary values and valid-sample counts were produced.
- Trial-plan generator produced 18 runs for the default 3-profile × 3-repetition × 2-mode matrix; fixed-seed generation was verified byte-for-byte deterministic.
- HTTP static route smoke check returned 200; unsupported POST returned 405; a traversal-style path was blocked with 403. This HTTP check used a temporary local WebSocket stub, so it does **not** validate real WebSocket signaling.

## Not yet validated

- A real browser connection with this revised code, including the new URL-configured auto-run path and queued-ICE behavior.
- Actual signaling through the installed `ws` dependency. The dependency could not be installed in this isolated review environment because package retrieval timed out; the lockfile is present, but this is not counted as a passing integration test.
- `setParameters()` behavior across the user's browser/version.
- Media traffic traversing the Linux interface where `tc netem` is applied.
- Repeated controlled baseline/adaptive comparisons.

## Research interpretation

The existing October 22 CSVs are short smoke tests (18 baseline samples over about 17 seconds; 22 adaptive samples over about 21 seconds). They support that the app connected and logged stats, and that the prior adaptive run recorded a 900 kbps requested cap. They do not demonstrate improvement under congestion. Do not reuse the old `intervalPacketLoss_pct` column as a valid interval-loss measurement; it was mislabeled by the earlier implementation.
