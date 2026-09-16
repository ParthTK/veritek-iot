# Failure and recovery test results

- Date: 2026-09-16T03:38:10.171Z
- Result: **19/19 passed**

| Check | Result | Detail |
|---|---|---|
| consumer connected at start | PASS | 4 subscriptions |
| consumer reconnected on its own | PASS | no manual intervention |
| telemetry flows again after reconnect | PASS |  |
| reconnect delay backs off and is capped | PASS | 573ms, 1104ms, 1956ms, 4000ms, 3633ms |
| reconnect delay is jittered | PASS | a fleet does not retry in lockstep: 2513, 2337, 2333, 2551ms |
| invalid credentials refused | PASS | Connection refused: Bad username or password |
| backend still consuming after a rejected client | PASS |  |
| publishing to another gateway's topic is refused | PASS | energy/v1/gateways/SOME-OTHER-GATEWAY/telemetry |
| backend unaffected by an ACL denial | PASS |  |
| malformed JSON stored and flagged | PASS | 1 marked INVALID_PAYLOAD |
| consumer survived malformed JSON | PASS |  |
| duplicate packet stored once | PASS | 8 rows before and after |
| out-of-order packets stored in measurement order | PASS | 6 readings, ordered by source time |
| burst of 60 buffered readings fully ingested | PASS | 240 telemetry rows written |
| consumer healthy after the burst | PASS |  |
| revoked gateway refused at CONNECT | PASS | Connection refused: Bad username or password |
| readiness fails while the database is down | PASS | HTTP 503 |
| liveness still passes (process is fine) | PASS | a database blip must not trigger a container restart |
| readiness recovers when the database returns | PASS | no restart required |

Every scenario recovered without manual intervention.
