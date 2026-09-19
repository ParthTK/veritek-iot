/**
 * Device provisioning from the command line (spec section 32).
 *
 * The same lifecycle operations the API exposes, for use during an install when
 * a terminal is closer to hand than a browser.
 *
 *   npm run provision -- create --uid GW-MUM-001 --site site-onida --meters 1,2
 *   npm run provision -- list
 *   npm run provision -- profile --uid GW-MUM-001
 *   npm run provision -- rotate  --uid GW-MUM-001
 *   npm run provision -- suspend --uid GW-MUM-001 --reason "site closed"
 *   npm run provision -- revoke  --uid GW-MUM-001 --reason "unit lost"
 *   npm run provision -- activate --uid GW-MUM-001
 *   npm run provision -- decommission --uid GW-MUM-001
 *
 * The MQTT password is printed exactly once, when it is created or rotated.
 */

const command = process.argv[2] ?? 'help';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

function bar(): void {
  process.stdout.write('-'.repeat(68) + '\n');
}

async function main(): Promise<void> {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  const { env } = await import('../src/config/env.js');
  const { configureLogger } = await import('../src/core/logger.js');
  configureLogger({ level: env.LOG_LEVEL as never, pretty: env.LOG_PRETTY });

  const { connectDb, closeDb } = await import('../src/db/index.js');
  const { migrate } = await import('../src/db/migrate.js');
  const database = await connectDb();
  await migrate(database);

  const { getGatewayByUid, listGateways } = await import('../src/db/repositories/gateways.js');
  const lifecycle = await import('../src/iot/devices/lifecycle.js');
  const { listCredentials } = await import('../src/db/repositories/mqttCredentials.js');

  const uid = flag('uid');
  const requireGateway = async (): Promise<{ id: string; gatewayUid: string }> => {
    if (!uid) throw new Error('--uid is required for this command');
    const gateway = await getGatewayByUid(uid);
    if (!gateway) throw new Error('No gateway with uid ' + uid);
    return gateway;
  };

  switch (command) {
    case 'create': {
      if (!uid) throw new Error('--uid is required, e.g. --uid GW-MUM-001');
      const meters = (flag('meters') ?? '1')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 247)
        .map((slaveId) => ({ slaveId }));

      const result = await lifecycle.provisionGateway({
        gatewayUid: uid,
        name: flag('name') ?? uid,
        siteId: flag('site') ?? null,
        hardwareModel: flag('model') ?? null,
        imei: flag('imei') ?? null,
        simNumber: flag('sim') ?? null,
        environment: (flag('environment') as 'staging' | 'production' | undefined) ?? undefined,
        meters,
        actor: 'cli',
      });

      bar();
      process.stdout.write('GATEWAY PROVISIONED\n');
      bar();
      process.stdout.write('Enter these into the gateway:\n\n');
      const connection = result.connectionProfile;
      const rows: Array<[string, string]> = [
        ['MQTT host', connection.host],
        ['MQTT port', String(connection.tlsPort) + (connection.plainPort ? ' (TLS) or ' + connection.plainPort + ' (plain)' : ' (TLS)')],
        ['TLS', connection.tls ? 'enabled' : 'disabled - commissioning only'],
        ['Username', connection.username],
        ['Password', result.mqttPassword],
        ['Client ID', connection.clientId],
        ['Publish topic', connection.telemetryTopic],
        ['Status topic', connection.statusTopic],
        ['Subscribe topic', connection.commandTopic],
        ['QoS', String(connection.qos)],
        ['Retain', 'off'],
      ];
      for (const [label, value] of rows) {
        process.stdout.write('  ' + label.padEnd(16) + value + '\n');
      }
      process.stdout.write(
        '\nThe password is shown once and stored only as a hash.\n' +
          'If it is lost: npm run provision -- rotate --uid ' + uid + '\n',
      );
      process.stdout.write('\nMeters: ' + meters.map((meter) => 'slave ' + meter.slaveId).join(', ') + '\n');
      process.stdout.write(
        'Still to set per meter: baud rate, parity, stop bits, and the register map.\n',
      );
      bar();
      break;
    }

    case 'list': {
      const gateways = await listGateways();
      const credentials = await listCredentials({ kind: 'device' });
      bar();
      process.stdout.write(
        'UID'.padEnd(24) + 'LIFECYCLE'.padEnd(16) + 'LINK'.padEnd(10) + 'CRED'.padEnd(11) + 'LAST DATA\n',
      );
      bar();
      for (const gateway of gateways) {
        const credential = credentials.find((entry) => entry.gatewayId === gateway.id);
        process.stdout.write(
          gateway.gatewayUid.slice(0, 23).padEnd(24) +
            gateway.lifecycleState.padEnd(16) +
            gateway.status.padEnd(10) +
            (credential?.status ?? 'none').padEnd(11) +
            (gateway.lastDataAt ?? 'never') + '\n',
        );
      }
      process.stdout.write('\n' + gateways.length + ' gateway(s)\n');
      break;
    }

    case 'profile': {
      const gateway = await requireGateway();
      const connection = lifecycle.connectionProfileFor(gateway.gatewayUid);
      bar();
      process.stdout.write('CONNECTION PROFILE - ' + gateway.gatewayUid + '\n');
      bar();
      process.stdout.write(JSON.stringify(connection, null, 2) + '\n');
      process.stdout.write('\nThe password is not shown. Rotate it if it has been lost.\n');
      break;
    }

    case 'rotate': {
      const gateway = await requireGateway();
      const result = await lifecycle.rotateCredentials(gateway.id, 'cli');
      bar();
      process.stdout.write('CREDENTIAL ROTATED - ' + gateway.gatewayUid + '\n');
      bar();
      process.stdout.write('  Username  ' + result.credential.mqttUsername + '\n');
      process.stdout.write('  Password  ' + result.mqttPassword + '\n');
      process.stdout.write('\nUpdate the gateway before its current session drops.\n');
      break;
    }

    case 'activate': {
      const gateway = await requireGateway();
      await lifecycle.activateGateway(gateway.id, 'cli');
      process.stdout.write(gateway.gatewayUid + ' is now active.\n');
      break;
    }

    case 'suspend': {
      const gateway = await requireGateway();
      await lifecycle.suspendGateway(gateway.id, flag('reason') ?? 'suspended from the CLI', 'cli');
      process.stdout.write(gateway.gatewayUid + ' suspended. Broker access refused from its next attempt.\n');
      break;
    }

    case 'revoke': {
      const gateway = await requireGateway();
      await lifecycle.revokeGateway(gateway.id, flag('reason') ?? 'revoked from the CLI', 'cli');
      process.stdout.write(gateway.gatewayUid + ' revoked. Telemetry history is unaffected.\n');
      break;
    }

    case 'decommission': {
      const gateway = await requireGateway();
      await lifecycle.decommissionGateway(gateway.id, 'cli');
      process.stdout.write(gateway.gatewayUid + ' decommissioned. Meters disabled, history retained.\n');
      break;
    }

    default: {
      process.stdout.write(
        '\nDevice provisioning\n\n' +
          '  create        --uid GW-MUM-001 [--site ID] [--meters 1,2] [--name N] [--model M]\n' +
          '                [--imei I] [--sim S] [--environment staging|production]\n' +
          '  list\n' +
          '  profile       --uid GW-MUM-001\n' +
          '  rotate        --uid GW-MUM-001\n' +
          '  activate      --uid GW-MUM-001\n' +
          '  suspend       --uid GW-MUM-001 --reason "..."\n' +
          '  revoke        --uid GW-MUM-001 --reason "..."\n' +
          '  decommission  --uid GW-MUM-001\n\n',
      );
    }
  }

  await closeDb();
}

main().catch((error: unknown) => {
  process.stderr.write('\n' + (error instanceof Error ? error.message : String(error)) + '\n\n');
  process.exitCode = 1;
});
