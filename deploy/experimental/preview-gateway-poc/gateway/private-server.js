import fs from 'node:fs';
import { createGateway } from './gateway.js';
import { createAssertionVerifier } from './assertion.js';
import { buildGatewayConfig } from './config.js';
import { validatePrivatePaths } from './boundary.js';
import peerCredentials from './peercred-linux.node';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required environment variable ${name} is unset`);
  return value;
}

const socketPath = required('PREVIEW_CORE_SOCKET');
const publicKeyPath = required('INGRESS_ASSERTION_PUBLIC_KEY_FILE');
const serviceUid = Number(required('GATEWAY_SERVICE_UID'));
const pilotUid = Number(required('PILOT_SERVICE_UID'));
const publicKey = validatePrivatePaths({ socketPath, publicKeyPath, serviceUid, pilotUid });
const config = buildGatewayConfig(process.env);
const verifier = createAssertionVerifier({
  publicKey,
  ownerLogin: config.owner,
  allowedNodeIds: config.ownerDeviceIds,
});
const core = createGateway({
  ...config,
  assertionVerifier: verifier,
  privateSocketOnly: true,
  verifyPrivateSource: (socket) => {
    const uid = peerCredentials.peerUid(socket._handle.fd);
    return Number.isInteger(uid) && uid === serviceUid;
  },
});

// No TCP listener is created. Socket mode 0600 limits access to the dedicated
// gateway UID shared by the Go ingress and this isolated core process.
const previousUmask = process.umask(0o077);
core.server.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600);
    const socketStat = fs.lstatSync(socketPath);
    if (!socketStat.isSocket() || socketStat.uid !== serviceUid || (socketStat.mode & 0o777) !== 0o600) throw new Error('created socket failed ownership/mode validation');
    process.stdout.write('private preview core listening on protected Unix socket\n');
  } catch (error) {
    core.server.close();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    process.umask(previousUmask);
  }
});
core.server.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    core.server.close(() => { if (process.exitCode === undefined) process.exitCode = 0; });
  });
}
