import fs from 'node:fs';
import { createGateway } from './gateway.js';
import { createAssertionVerifier } from './assertion.js';
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
const allowedPorts = required('PREVIEW_ALLOWED_PORTS').split(',').map((v) => Number(v.trim()));
const verifier = createAssertionVerifier({
  publicKey,
  ownerLogin: required('TAILNET_OWNER_LOGIN'),
  allowedNodeIds: required('TAILNET_ALLOWED_REMOTE_NODE_IDS').split(',').map((v) => v.trim()),
});
const core = createGateway({
  owner: required('TAILNET_OWNER_LOGIN'),
  ownerDeviceIds: required('TAILNET_ALLOWED_REMOTE_NODE_IDS').split(',').map((v) => v.trim()),
  excludedNodeIds: [required('TAILNET_GATEWAY_NODE_ID'), required('TAILNET_HOST_NODE_ID')],
  controlHost: required('PREVIEW_CONTROL_HOST'),
  previewDomain: required('PREVIEW_DOMAIN'),
  dashboardOrigin: required('DASHBOARD_ORIGIN'),
  containerAddress: required('PREVIEW_PRIVATE_IPV4'),
  allowedPorts,
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
