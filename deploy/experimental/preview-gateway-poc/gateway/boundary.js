import fs from 'node:fs';
import path from 'node:path';

function checkDirectoryChain(directory, serviceUid) {
  const absolute = path.resolve(directory);
  const components = absolute.split(path.sep).filter(Boolean);
  if (components.length === 0) throw new Error('private socket/key directory cannot be filesystem root');
  let current = path.parse(absolute).root;
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory component: ${current}`);
    const isFinal = i === components.length - 1;
    if (isFinal) {
      if (stat.uid !== serviceUid || (stat.mode & 0o077) !== 0) throw new Error(`private directory must be service-UID-owned mode 0700: ${current}`);
    } else if ((stat.mode & 0o022) !== 0 || (stat.uid !== 0 && stat.uid !== serviceUid)) {
      throw new Error(`ancestor must be root/service-owned and not group/other-writable: ${current}`);
    }
  }
}

export function validatePrivatePaths({ socketPath, publicKeyPath, serviceUid, pilotUid }) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || typeof process.geteuid !== 'function') throw new Error('private bridge requires Linux UID and SO_PEERCRED support');
  if (!Number.isInteger(serviceUid) || !Number.isInteger(pilotUid) || serviceUid <= 0 || pilotUid <= 0 || serviceUid === pilotUid || process.getuid() !== serviceUid || process.geteuid() !== serviceUid) {
    throw new Error('gateway process must run as the dedicated service UID distinct from Pilot UID');
  }
  for (const filePath of [socketPath, publicKeyPath]) {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('private paths must be absolute');
    checkDirectoryChain(path.dirname(filePath), serviceUid);
  }
  const keyFd = fs.openSync(publicKeyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
  let keyData;
  try {
    const key = fs.fstatSync(keyFd);
    if (!key.isFile() || key.uid !== serviceUid || (key.mode & 0o077) !== 0) throw new Error('public key must be a service-owned regular mode-0600 file');
    keyData = fs.readFileSync(keyFd);
  } finally {
    fs.closeSync(keyFd);
  }
  try {
    fs.lstatSync(socketPath);
    throw new Error('socket path already exists; refusing to unlink or replace it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return keyData;
}
