# Controller implementation notes

This update replaces the original fixed-target threshold controller with a stateful bounded sender-adaptation controller.

Changed files:
- `public/adaptation-controller.js`
- `public/app.js`
- `public/index.html`
- `tests/adaptation-controller.test.js`

The controller retains native WebRTC GCC and only requests changes to the sender's encoder `maxBitrate` parameter. It does not claim access to GCC internals. The previous manual target bitrate input and automated `targetKbps` setting have been removed. The sender's pre-experiment maxBitrate value is preserved and restored after sustained recovery or when adaptive logging stops.

The implementation is a first experimental controller configuration. It has unit-test coverage for persistence, recovery, missing telemetry, original sender cap preservation, and reset behavior. Passing unit tests does not establish real-world performance improvement; live matched experiments are still required.
