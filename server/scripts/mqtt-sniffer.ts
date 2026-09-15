import mqtt from 'mqtt';
import { env, mqttDisplayUrl, mqttProtocol } from '../src/config/env.js';

/**
 * Raw MQTT subscriber.
 *
 * THIS IS THE FIRST THING TO RUN WHEN THE GATEWAY ARRIVES.
 *
 * Before touching the dashboard, before writing a single mapping: subscribe,
 * let the unit publish, and capture exactly what it sends. It prints the topic,
 * the byte-for-byte payload, the receive time, the client id and the interval
 * between packets - which is the complete answer to "what does this hardware
 * actually emit?".
 *
 *   npm run sniffer                       # uses MQTT_SUBSCRIBE_TOPICS
 *   npm run sniffer -- "technode/#" "#"   # or explicit filters
 *
 * The backend records the same packets in `raw_iot_messages` whether or not
 * this is running; this is for watching them live on a terminal.
 */

const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const topics = filters.length ? filters : env.MQTT_SUBSCRIBE_TOPICS;

const url = mqttProtocol() + '://' + env.MQTT_HOST + ':' + env.MQTT_PORT;
const lastSeen = new Map<string, number>();
let count = 0;

const rule = '='.repeat(78);

process.stdout.write('\nMQTT sniffer\n' + rule + '\n');
process.stdout.write('BROKER:      ' + mqttDisplayUrl() + '\n');
process.stdout.write('SUBSCRIBING: ' + topics.join(', ') + '\n');
process.stdout.write(rule + '\n\n');

const client = mqtt.connect(url, {
  clientId: 'veritek-sniffer-' + Math.random().toString(36).slice(2, 8),
  username: env.MQTT_USERNAME ?? env.EMBEDDED_BROKER_DEFAULT_USERNAME,
  password: env.MQTT_PASSWORD ?? env.EMBEDDED_BROKER_DEFAULT_PASSWORD,
  clean: true,
  reconnectPeriod: 3000,
});

client.on('connect', () => {
  process.stdout.write('connected; waiting for packets. Ctrl+C to stop.\n\n');
  for (const topic of topics) {
    client.subscribe(topic, { qos: 1 }, (error) => {
      if (error) process.stderr.write('subscribe failed for ' + topic + ': ' + error.message + '\n');
    });
  }
});

client.on('error', (error) => {
  process.stderr.write('broker error: ' + error.message + '\n');
});

client.on('message', (topic, payload, packet) => {
  count += 1;
  const now = Date.now();
  const previous = lastSeen.get(topic);
  lastSeen.set(topic, now);

  const text = payload.toString('utf8');
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    pretty = text + '\n  (not valid JSON - the bytes above are exactly what arrived)';
  }

  process.stdout.write(rule + '\n');
  process.stdout.write('MESSAGE #' + count + '\n');
  process.stdout.write('TOPIC:         ' + topic + '\n');
  process.stdout.write('TIME RECEIVED: ' + new Date(now).toISOString() + '\n');
  process.stdout.write('QOS/RETAIN:    ' + packet.qos + ' / ' + packet.retain + '\n');
  process.stdout.write('BYTES:         ' + payload.byteLength + '\n');
  process.stdout.write(
    'SINCE LAST:    ' + (previous ? ((now - previous) / 1000).toFixed(1) + ' s on this topic' : 'first on this topic') + '\n',
  );
  process.stdout.write('RAW PAYLOAD:\n' + pretty + '\n\n');
});

process.on('SIGINT', () => {
  process.stdout.write('\n' + rule + '\nCaptured ' + count + ' message(s) on ' + lastSeen.size + ' topic(s):\n');
  for (const topic of lastSeen.keys()) process.stdout.write('  ' + topic + '\n');
  process.stdout.write(
    '\nSend the topic and one full raw payload, plus the meter register table, to finish the mapping.\n',
  );
  client.end(true, {}, () => process.exit(0));
});
