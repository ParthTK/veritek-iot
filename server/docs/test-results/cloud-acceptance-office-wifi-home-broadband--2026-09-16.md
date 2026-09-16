# Cloud acceptance test

- Date: 2026-09-16T23:17:44.346Z
- Network: office wifi (home broadband)
- Broker: mqtts://mqtt.8-231-120-125.sslip.io:8883
- API: https://api.8-231-120-125.sslip.io
- Result: **14/14 passed**

| Check | Result | Detail |
|---|---|---|
| DNS resolves mqtt.8-231-120-125.sslip.io | PASS | 8.231.120.125 |
| resolves to a public address | PASS | 8.231.120.125 |
| TLS listener answers on 8883 | PASS |  |
| certificate is trusted by a public CA | PASS | C=US O=Let's Encrypt CN=YE1 |
| certificate is not near expiry | PASS | 89 days remaining (expires 2026-12-15T22:08:46.000Z) |
| anonymous connection refused | PASS | Connection refused: Not authorized |
| gateway credential accepted | PASS | 122ms to CONNACK |
| publish accepted with QoS 1 acknowledgement | PASS | 18ms to PUBACK |
| publishing as another gateway is refused over the wire | PASS | energy/v1/gateways/NOT-THIS-GATEWAY/telemetry |
| API reachable over HTTPS | PASS | HTTP 200 |
| dashboard sign-in | PASS | HTTP 200 |
| the published reading is readable through the API | PASS | voltage_l1 = 577.1 V at 2026-09-16T23:17:32.786Z |
| measurement time preserved end to end | PASS | 0s between what we sent and what was stored |
| dashboard receives a live update without polling | PASS | SSE telemetry event delivered |
