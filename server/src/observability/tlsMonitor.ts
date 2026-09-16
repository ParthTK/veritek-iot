import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { metrics } from './metrics.js';

const log = createLogger('tls:monitor');

/**
 * Certificate expiry watch (spec sections 4 and 20).
 *
 * Renewal is automated, which is exactly why this exists: an automated renewal
 * that silently stops working looks identical to one that is working, right up
 * until every gateway in the estate fails TLS on the same morning.
 *
 * Two independent checks, because they fail differently:
 *
 *   - the certificate file on disk, which catches a broken renewal;
 *   - the certificate the broker is actually serving, which catches a renewal
 *     that worked but was never loaded.
 */

export interface CertificateStatus {
  source: 'file' | 'listener';
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysRemaining: number | null;
  ok: boolean;
  error: string | null;
}

function describe(certificate: X509Certificate, source: CertificateStatus['source']): CertificateStatus {
  const validTo = new Date(certificate.validTo);
  const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
  return {
    source,
    subject: certificate.subject ?? null,
    issuer: certificate.issuer ?? null,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining,
    ok: daysRemaining > env.TLS_EXPIRY_WARNING_DAYS,
    error: null,
  };
}

/** Read the certificate file the broker and proxy are configured with. */
export function checkCertificateFile(path = env.TLS_CERT_PATH_FOR_EXPIRY_CHECK): CertificateStatus | null {
  if (!path) return null;
  try {
    return describe(new X509Certificate(readFileSync(path)), 'file');
  } catch (error) {
    return {
      source: 'file',
      subject: null,
      issuer: null,
      validFrom: null,
      validTo: null,
      daysRemaining: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ask the live TLS listener what it is actually serving.
 *
 * `rejectUnauthorized: false` is deliberate and safe here: we are inspecting
 * the certificate, not trusting it, and a self-signed or expired one is
 * precisely what we want to be able to report on.
 */
export function checkCertificateListener(
  host = env.MQTT_PUBLIC_HOST,
  port = env.MQTT_PUBLIC_TLS_PORT,
  timeoutMs = 8000,
): Promise<CertificateStatus> {
  return new Promise((resolve) => {
    const fail = (message: string): void =>
      resolve({
        source: 'listener',
        subject: null,
        issuer: null,
        validFrom: null,
        validTo: null,
        daysRemaining: null,
        ok: false,
        error: message,
      });

    let settled = false;
    const socket = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        settled = true;
        const peer = socket.getPeerX509Certificate?.();
        socket.end();
        if (!peer) {
          fail('listener presented no certificate');
          return;
        }
        resolve(describe(peer, 'listener'));
      },
    );

    socket.on('timeout', () => {
      if (!settled) {
        socket.destroy();
        fail('connection to ' + host + ':' + port + ' timed out');
      }
    });
    socket.on('error', (error: Error) => {
      if (!settled) fail(error.message);
    });
  });
}

/** Update the expiry gauge Prometheus alerts on, and log when it gets close. */
export async function refreshCertificateMetrics(): Promise<CertificateStatus | null> {
  const fromFile = checkCertificateFile();
  const status =
    fromFile && fromFile.daysRemaining !== null
      ? fromFile
      : env.MQTT_TLS
        ? await checkCertificateListener()
        : fromFile;

  if (!status) return null;

  if (status.daysRemaining === null) {
    log.debug('no TLS certificate available to inspect', { error: status.error });
    return status;
  }

  metrics.tlsCertificateExpirySeconds.set(status.daysRemaining * 86_400);

  if (status.daysRemaining <= 7) {
    log.error('TLS certificate expires within a week; automated renewal has failed', {
      source: status.source,
      validTo: status.validTo,
      daysRemaining: status.daysRemaining,
    });
  } else if (status.daysRemaining <= env.TLS_EXPIRY_WARNING_DAYS) {
    log.warn('TLS certificate is approaching expiry', {
      source: status.source,
      validTo: status.validTo,
      daysRemaining: status.daysRemaining,
    });
  }

  return status;
}

let timer: NodeJS.Timeout | null = null;

export function startTlsMonitor(intervalHours = 6): void {
  if (timer) return;
  timer = setInterval(
    () => {
      void refreshCertificateMetrics().catch((error: unknown) =>
        log.error('certificate check failed', { error }),
      );
    },
    intervalHours * 3_600_000,
  );
  timer.unref?.();
  void refreshCertificateMetrics().catch(() => undefined);
}

export function stopTlsMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
