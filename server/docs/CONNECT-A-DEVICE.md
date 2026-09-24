# Connecting a device

What a device has to do to get its readings onto the platform. Everything here
is enforced by the broker, so a device that follows it works and a device that
strays is refused rather than silently ignored.

## 1. Get credentials

Every device has its own login. There is no shared password and no anonymous
access — a device that has not been provisioned cannot connect at all.

Dashboard → **Administration → Devices → Connect a device**. Fill in:

| Field | Meaning |
|---|---|
| Device ID | The device's name on the broker and in every topic. Often the serial or SIM number. Letters, digits, `-` and `_`. |
| Display name | What it is called on the dashboard. |
| Site | Where it is installed. |
| Modbus slave IDs | One meter per id on the RS485 bus, e.g. `1,2,3`. |

The screen then shows the connection settings, including the password.

**The password is shown once.** It is stored only as a salted hash, so nobody —
including the server — can read it back. If it is lost, use **Rotate password**
on that device: it keeps its identity, its history and its topics, and only the
password changes.

The same thing from the API, if you are scripting a production run:

```bash
curl -sX POST https://api.<your-host>/api/provisioning/gateways \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"gatewayUid":"GW-MUM-001","siteId":"site-abc","meters":[{"slaveId":1}]}'
```

## 2. Connect

| Setting | Value |
|---|---|
| Host | `mqtt.<your-host>` — a DNS name, never an IP, so the server can move |
| Port | **8883**, MQTT over TLS |
| TLS | Required. Publicly trusted certificate (Let's Encrypt); the device validates it normally, no custom CA to install |
| Username | the device ID |
| Password | issued at provisioning |
| Client ID | the device ID |
| Protocol | MQTT 3.1, 3.1.1 or 5 |
| Clean session | `false`, so commands sent while it was offline are still delivered |
| Keepalive | 60 s is a good default on cellular |
| QoS | **1** for telemetry — at-least-once. The platform discards duplicates, so a retry can never double-count energy |

Port 1883 (no TLS) is open only during a commissioning window and sends the
password in clear text. Use it to get a stubborn device talking, then move it
to 8883.

If TLS fails, the usual cause is the device's clock: certificate validation
needs the date to be roughly right.

## 3. Topics

Replace `{device-id}` with the device's own ID. It may use **only** these.

| Topic | Direction | Purpose |
|---|---|---|
| `energy/v1/gateways/{device-id}/telemetry` | device → platform | readings |
| `energy/v1/gateways/{device-id}/status` | device → platform | online/offline, retained |
| `energy/v1/gateways/{device-id}/command` | platform → device | subscribe to this |
| `energy/v1/gateways/{device-id}/response` | device → platform | replies to commands |

A device may not publish on another device's topics, and may not subscribe to a
wildcard. Both are refused by the broker, not merely ignored.

Set a **last will** on the status topic, so the broker announces the device if
it drops without saying goodbye:

- topic `energy/v1/gateways/{device-id}/status`
- payload `{"status":"offline"}`
- QoS 1, retained

## 4. Payload

JSON on the telemetry topic:

```json
{
  "gateway_id": "GW-MUM-001",
  "slave_id": 1,
  "timestamp": "2026-09-22T18:30:00+05:30",
  "seq": 1041,
  "registers": {
    "voltage_l1": 238.7,
    "current_l1": 14.2,
    "active_power_kw": 9.87,
    "power_factor": 0.962,
    "frequency_hz": 50.02,
    "energy_import_kwh": 15432.5
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `gateway_id` | no | Must match the device it is authenticated as. A packet naming another device is refused. |
| `slave_id` | yes, with more than one meter | Which meter on the RS485 bus. Defaults to 1. |
| `timestamp` | recommended | When the reading was **taken**. ISO 8601 with an offset is clearest; epoch seconds or milliseconds also work. Omit it and the server uses arrival time, which is wrong for anything buffered. |
| `seq` | no | Helps spot gaps. |
| `registers` | yes | The measurements. |

Send whichever of these the meter reports — none is required individually:

`voltage_l1` `voltage_l2` `voltage_l3` `voltage_avg` · `voltage_l12` `voltage_l23`
`voltage_l31` · `current_l1` `current_l2` `current_l3` `current_neutral` ·
`active_power_kw` `reactive_power_kvar` `apparent_power_kva` (and `_l1/_l2/_l3`
variants) · `power_factor` (and per phase) · `frequency_hz` ·
`energy_import_kwh` `energy_export_kwh` `apparent_energy_kvah`
`reactive_energy_kvarh`

Phase voltages are line-to-neutral (~240 V on a 415 V supply); `voltage_l12`
and friends are line-to-line. Energy values are **cumulative meter totals**, not
per-interval amounts — the platform subtracts, and handles meter resets and
counter rollovers itself.

Keys it does not recognise are still stored and can be mapped afterwards, so an
unusual payload is never lost. A payload in a completely different shape is
fine too: capture one packet and map it under **Commissioning**, rather than
changing the firmware.

Keep each message under 1 MB.

### Buffering while offline

If the link drops, queue readings and send them when it returns, each with its
own original `timestamp`. They are filed at the time they were measured, and
history is corrected retroactively — including the hourly and daily figures
already calculated. Resending the same reading twice is harmless; it is
recognised and discarded.

## 5. Check it worked

Publish one reading, then look at **Devices**: the device turns online within a
minute and its meter shows values.

To test without the hardware, from any machine with
[mosquitto-clients](https://mosquitto.org/download/):

```bash
mosquitto_pub -h mqtt.<your-host> -p 8883 --capath /etc/ssl/certs \
  -u 'GW-MUM-001' -P '<password>' -q 1 \
  -t 'energy/v1/gateways/GW-MUM-001/telemetry' \
  -m '{"gateway_id":"GW-MUM-001","slave_id":1,"timestamp":"2026-09-22T18:30:00+05:30","registers":{"voltage_l1":238.7,"active_power_kw":9.87,"energy_import_kwh":15432.5}}'
```

If nothing appears, in order:

1. **Connection refused: not authorised** — wrong username or password, or the
   device has been suspended or revoked. Rotate its password.
2. **Publish accepted but nothing on the dashboard** — almost always the topic.
   It must contain the device's own ID exactly.
3. **Device online, meter empty** — the payload parsed but no known measurement
   keys were found. Open **Commissioning**, which shows the raw packet exactly
   as it arrived, and map its fields.
