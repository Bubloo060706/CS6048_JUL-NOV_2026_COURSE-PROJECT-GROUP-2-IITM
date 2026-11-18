# v2 validation report

Validation performed in the package working directory on 2026-10-30.

## Passed
- `npm test`: 9/9 existing adaptation-controller tests passed.
- `python -m unittest discover -s tests -p 'test_*.py' -v`: 4/4 tests passed.
  - Immutable matched baseline/adaptive pair generation.
  - Deterministic schedule generation for a fixed seed.
  - Schedule replay preserves the exact CSV schedule and remains dry-run only.
  - Raw getStats bundle flattening keeps report types/IDs distinct.
- `node --check public/app.js` passed.
- `node --check public/adaptation-controller.js` passed.
- `node --check server.js` passed.
- Python byte-compilation passed for analysis and experiment scripts.
- `bash -n` passed for both network impairment scripts.
- Offline analysis ran against the supplied baseline and adaptive CSV examples and generated summaries/stacked plots.
- Schedule generation produced immutable schedule files and a paired run plan; replay output was byte-for-byte identical to its source schedule.
- Dry-run schedule execution completed without changing network settings.

## Not claimed / requires physical validation
- No live two-machine WebRTC call was run as part of this code update.
- Browser runtime collection of the expanded raw telemetry has not been exercised in a real Chrome session in this environment.
- No live `tc` impairment was applied.
- The impairment runner intentionally refuses physical/Wi-Fi interfaces and only allows a disposable veth with a default `noqueue` root. It is not yet wired to the actual Windows/Ubuntu media path.
- No performance claim is made for the adaptation controller. Its existing absolute-threshold heuristic is retained as a prototype; the relative-baseline Phase 7 work remains deferred.
