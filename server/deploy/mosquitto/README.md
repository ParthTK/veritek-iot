# Mosquitto setup

Production broker configuration. Skip all of this while the embedded
development broker is in use (`EMBEDDED_BROKER_ENABLED=true`).

## 1. Create the password file

```bash
# backend account
docker run --rm -it -v "$PWD:/work" eclipse-mosquitto:2 \
  mosquitto_passwd -c /work/passwd veritek-backend

# one entry per gateway; the password is the device token issued by
# POST /api/admin/gateways/:id/token
docker run --rm -it -v "$PWD:/work" eclipse-mosquitto:2 \
  mosquitto_passwd /work/passwd GW-ABC-0001
```

`passwd` holds salted hashes, not plaintext. Keep it out of version control.

## 2. Create the ACL file

```bash
cp aclfile.example aclfile
```

Add one block per gateway. The rule that matters: a gateway may write only
under `veritek/<its-own-uid>/...`. Without it, any device credential can
publish readings attributed to any other meter.

## 3. Point the backend at it

```
MQTT_HOST=<broker host>
MQTT_PORT=8883
MQTT_TLS=true
MQTT_USERNAME=veritek-backend
MQTT_PASSWORD=<the password set in step 1>
EMBEDDED_BROKER_ENABLED=false
```

## 4. TLS

Uncomment the 8883 listener in `mosquitto.conf` and drop `ca.crt`,
`server.crt` and `server.key` into `certs/`. Do this only after confirming
the gateway supports TLS and which CA it will trust - that is one of the four
things still open until the hardware is on the bench.

Until then, keep 1883 bound to a private interface reachable over the
cellular APN or a VPN. Never expose an anonymous or plaintext broker to the
public internet.
