# Final WebRTC Project Archive

This archive organizes the completed WebRTC project materials without modifying the original source ZIP.

## Folder guide
- `00_Project_Guide/` — project documentation, implementation notes, review notes, and test reports.
- `01_Source_Code/` — WebRTC application, adaptation controller, server, certificates, and dependency configuration.
- `02_Experimental_Design/` — protocols, schedules, baseline profiles, trial plans, and execution scripts.
- `03_Baseline_Experiments/` — B1, B2, B3 baseline records and Ubuntu endpoint exports.
- `04_Adaptive_Experiments/` — final W1, W2, W3 (0.92) and W3 mitigation (0.82) results.
- `05_W2_Ablation_and_Sensitivity/` — FPS ablation, RTT sensitivity, and supporting network details.
- `07_Complementary_Windows_Peer_Exports/` — corresponding Windows-side baseline and adaptive exports.
- `08_Analysis_Tools/` — analysis scripts and W3 root-cause analysis materials.
- `09_Tests_and_Validation/` — automated tests and network validation evidence.

`FILE_MANIFEST.json` records the archived file paths, source provenance, sizes, and SHA-256 checksums. Generated dependency folders, Python bytecode/cache, temporary backups, and superseded experiment variants were excluded.

**Security note:** `01_Source_Code/certs/lan-key.pem` is a private TLS key. Keep this archive private; do not publish or share the key publicly.
