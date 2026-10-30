'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');

function installationLock(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target || path.dirname(target) === target) throw new Error('Invalid installation lock target.');
  const identity = createHash('sha256').update(process.platform === 'win32' ? target.toLowerCase() : target).digest('hex');
  return { file: path.join(path.dirname(target), `.recruiters-installation-${identity}.lock`), pipe: `RecruitersCompanionInstallation-${identity}` };
}

async function claimInstallation(target) {
  const lock = installationLock(target);
  if (process.platform === 'win32') {
    // Node holds the kernel pipe itself: no guardian process can die and
    // accidentally release exclusion while its application is still running.
    const server = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(`\\\\.\\pipe\\${lock.pipe}`, resolve);
      });
    } catch (error) {
      // A .NET helper's single-instance pipe reports EBUSY through libuv;
      // it is an occupied installation, never permission to proceed unlocked.
      if (['EADDRINUSE', 'EACCES', 'EBUSY'].includes(error.code)) return null;
      throw error;
    }
    server.unref();
    let releasing;
    return () => releasing ??= new Promise(resolve => server.close(resolve));
  }
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Linked installation lock parent.');
  const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(lock.file, flags | (process.platform === 'darwin' ? fs.constants.O_NONBLOCK | 0x20 : 0), 0o600);
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) throw new Error('Unsafe installation lock file.');
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null;
    throw error;
  }
  if (process.platform === 'linux') {
    try {
      // flock operates on the inherited open file description. The parent
      // retains that descriptor, so its lock survives the command's exit.
      const code = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['-n', '-E', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Installation exclusion timed out.')); }, 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', result => { clearTimeout(timer); resolve(result); });
      });
      if (code === 73) { fs.closeSync(fd); return null; }
      if (code !== 0) throw new Error('Installation exclusion was unavailable.');
    } catch (error) { fs.closeSync(fd); throw error; }
  } else if (process.platform !== 'darwin') { fs.closeSync(fd); throw new Error('Unsupported installation lock platform.'); }
  let released = false;
  return () => { if (!released) { released = true; fs.closeSync(fd); } };
}


module.exports = { installationLock, claimInstallation };
