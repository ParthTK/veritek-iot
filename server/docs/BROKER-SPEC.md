# VERITEK MQTT broker — device connection spec

For the device supplier's integration engineer. Everything needed to point a
device at our broker. **Device credentials are issued per unit and sent
separately — never in this document.**

---

## Broker

| | |
|---|---|
| Software | **Eclipse Mosquitto 2.1.2** (self-hosted, not a third-party cloud service) |
| Hosting | Google Cloud Compute Engine, asia-south1 (Mumbai) — dedicated VM, Docker, static public IP |
| Host | `mqtt.8-231-120-125.sslip.io` (resolves to 8.231.120.125) |
| Port | **8883** — MQTT over TLS |

Configure the device with the **hostname, not the IP**: the address can change,
the name will not.

Port 1883 (no TLS) is currently open for commissioning and will be closed. It
still requires a username and password, but sends them in clear text.

## TLS

Server-authenticated. The device does **not** need a client certificate.

| | |
|---|---|
| Minimum version | TLS 1.2 (1.0 and 1.1 refused) |
| Server certificate | Let's Encrypt, **ECDSA**, auto-renewed. Valid to 15 Dec 2026 |
| Chain served | leaf → `Let's Encrypt YE1` → `ISRG Root YE` → `ISRG Root X2` |
| SNI | Required — the device must send the hostname in the TLS handshake |
| Client certificate | Not required |

**Please check on your side:** this is an ECDSA chain under `ISRG Root X2`. Some
embedded trust stores carry only the older `ISRG Root X1`. If the device cannot
validate it, we can supply the root as a PEM to load, or reissue the certificate
as RSA under X1 — tell us which the hardware supports.

## Authentication

Mandatory. Anonymous connections are refused.

| | |
|---|---|
| Method | MQTT username and password |
| Scope | One credential per device — no shared account. Any one can be revoked or rotated without touching the others |
| Username | The device ID we assign (typically the serial or IMEI). It also appears in the device's topics |
| Password | 32 random characters, issued with the device ID. Stored only as a salted hash, so it cannot be read back — if lost, we rotate rather than recover |

## Protocol settings

| | |
|---|---|
| MQTT version | 3.1, 3.1.1 or 5.0 (all three tested against this broker) |
| Client ID | The device ID |
| QoS | **1** — at-least-once. Duplicates are detected and discarded, so a retry can never double-count energy. QoS 0 works but loses readings on a dropped link |
| Clean session | `false`, so commands sent while the device was offline are still delivered |
| Keepalive | 60 s |
| Max packet size | 1 MB — enough to flush an offline buffer as one batch |
| Retained messages | Allowed; used on the status topic |
| Last will | Expected: topic `…/status`, payload `{"status":"offline"}`, QoS 1, retained |

## Topics

`{DEVICE_ID}` is the device's own ID. It may use **only** these four, and the
broker enforces that rather than ignoring a stray publish.

| Topic | Direction | Purpose |
|---|---|---|
| `energy/v1/gateways/{DEVICE_ID}/telemetry` | device → us | meter readings |
| `energy/v1/gateways/{DEVICE_ID}/status` | device → us | online/offline, retained, last-will topic |
| `energy/v1/gateways/{DEVICE_ID}/command` | us → device | the one topic it subscribes to |
| `energy/v1/gateways/{DEVICE_ID}/response` | device → us | replies to commands |

What the broker refuses, so it is not a surprise in testing:

| Attempt | Result |
|---|---|
| Publishing to another device's topic | MQTT 5: PUBACK reason **135**. MQTT 3.1.1: acknowledged, then dropped |
| Subscribing to a wildcard (`#`, `+`) | SUBACK failure `0x80` |
| Connecting anonymously or with a revoked credential | CONNACK "not authorised" (rc 5 / reason 135) |

Under MQTT 3.1.1 a refused publish is still acknowledged and then discarded, so
test with MQTT 5 if you want refusals to be visible.

## Payload

JSON on the telemetry topic:

```json
{
  "gateway_id": "GW-MUM-001",
  "slave_id": 1,
  "timestamp": "2026-09-23T18:30:00+05:30",
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

| Field | Notes |
|---|---|
| `gateway_id` | Optional. If sent it must match the authenticated device — a packet naming another device is rejected |
| `slave_id` | Which meter on the RS485 bus. Required when a device polls more than one; defaults to 1 |
| `timestamp` | When the reading was **taken**. ISO 8601 with offset preferred; epoch seconds or milliseconds accepted. Omitted, we use arrival time — wrong for anything buffered |
| `seq` | Optional. Helps spot gaps |
| `registers` | The measurements — send whichever the meter reports |

Recognised measurement keys:

`voltage_l1` `voltage_l2` `voltage_l3` `voltage_avg` `voltage_l12` `voltage_l23`
`voltage_l31` `current_l1` `current_l2` `current_l3` `current_neutral`
`active_power_kw` `reactive_power_kvar` `apparent_power_kva` `power_factor`
`frequency_hz` `energy_import_kwh` `energy_export_kwh` `apparent_energy_kvah`
`reactive_energy_kvarh`

Phase voltages are line-to-neutral (~240 V on a 415 V supply); `voltage_l12` and
friends are line-to-line. Energy values are **cumulative meter totals**, not
per-interval amounts — we do the subtraction, including meter resets and counter
rollovers. Keys we don't recognise are still stored and can be mapped
afterwards, so nothing is lost.

**If the device's topic or payload is fixed in firmware, that is fine.** Send us
one real captured packet and the topic it arrives on, and we map it on our side
— no firmware change needed.

## Buffering while offline

If the link drops, queue readings and send them when it returns, each keeping
its **original** `timestamp`. They are filed at the time they were measured and
history is corrected retroactively, including figures already calculated.
Re-sending the same reading is harmless — it is recognised and discarded.

## Testing without the hardware

Any machine with `mosquitto-clients`, using credentials we issue:

```bash
mosquitto_pub -h mqtt.8-231-120-125.sslip.io -p 8883 --capath /etc/ssl/certs \
  -u 'GW-MUM-001' -P '<password>' -q 1 \
  -t 'energy/v1/gateways/GW-MUM-001/telemetry' \
  -m '{"slave_id":1,"timestamp":"2026-09-23T18:30:00+05:30","registers":{"voltage_l1":238.7,"active_power_kw":9.87,"energy_import_kwh":15432.5}}'
```

The device appears on our dashboard within a minute of its first reading.

---

## The device: Technode TIG-5

We have the TIG-5 manual (V1.1) and the platform is configured for it. From the
manual, this is what matches and what still needs confirming.

**Confirmed from the manual — no problem:**

| | |
|---|---|
| MQTT v3.1 | Our broker accepts it (tested: 3.1, 3.1.1 and 5 all connect) |
| Broker address | Accepts a domain name, max 90 characters. Ours is 30 |
| Username / password | Supported via `SET MQTT CONFIG` |
| Data topic | Configurable, so the unit publishes on our namespace |
| Payload | `{"ID","Status","Signal","Location","data":{…},"TS","DT"}` — the platform reads this shape as it is |
| Offline buffering | `DATA_BUFFER_ENABLED=1` |
| Modbus register map | Datatype, byte order, scaling and function code all map onto what we already store |

**Commands to set on the unit** (SMS, or published to `<imei>/cmd`):

```
SET MQTT CONFIG#mqtt.8-231-120-125.sslip.io,8883,<username>,<password>
SET DATA TOPIC#energy/v1/gateways/<imei>/telemetry
SET GATEWAY CONFIG#<location>,<apn>,<upload seconds>,1,1,0
```

The username and password are the ones we issue per device; provision the unit
under its **IMEI**, since that is what it reports as `"ID"`.

The last two `1`s are RTC calibration and offline buffering — please leave both
on. Readings are filed at the time they were measured, so an accurate clock and
a buffer that survives an outage are what keep history correct.

Its other three topics are fixed in firmware and we have allowed for them as they
are — `<imei>/connection`, `<imei>/cmd`, `<imei>/cmd-res`. Nothing to change there.

**Still to confirm — four questions:**

1. **TLS on 8883.** The manual names the port but documents no certificate or CA
   setting, and `SET MQTT CONFIG` has no TLS flag. Does the unit negotiate TLS
   when the port is 8883? If it does, does it validate the server certificate,
   and against which root store? Ours is an ECDSA chain under `ISRG Root X2`.
   If it cannot do TLS at all, say so plainly — we will keep a plaintext port
   open for it, but we need to know that is what we are running.
2. **Buffered readings.** When the link returns and the unit flushes its buffer,
   does each record keep the `TS` from when it was measured, or does it get the
   time it was sent? This decides whether an outage leaves a gap or fills in
   correctly.
3. **QoS.** What QoS does it publish at? QoS 1 means a reading survives a dropped
   link; at QoS 0 it is gone. Is it settable?
4. **Multiple meters.** With more than one meter on the RS485 bus, everything
   lands in one flat `data` object with no slave id. We handle that by reading
   the slave from the variable name — so please name them `VRN_1`, `KWH_1`,
   `VRN_2`, `KWH_2` and so on, one suffix per meter. Confirm the nine-character
   limit allows the names you need.

Also useful, whenever convenient: **one real captured packet** from a unit wired
to an actual energy meter. The variable names are the installer's choice, so a
real packet tells us the names in use rather than the ones we assumed.

---

## What we need from you (any other hardware)

If a different model is used instead:

1. Does it support **TLS 1.2 with SNI**? Can it load a custom root CA, and which roots ship with it — `ISRG Root X1`, `ISRG Root X2`, both?
2. Does it support **MQTT username and password** authentication?
3. Is the **publish topic configurable**, or fixed by firmware? If fixed, what is it?
4. Is the **payload configurable or documented**? One real captured packet is worth more than a schema.
5. Are **QoS and clean-session** configurable?
6. Is the **client ID** settable, or fixed to the IMEI?
7. Publish interval, and does it **buffer and backfill** with original timestamps after an outage?

Please don't reply with any password in the message body.
