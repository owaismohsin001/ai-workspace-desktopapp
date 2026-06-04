'use strict';

// Phase 6 — automated reverse SSH tunnel manager.
//
// What it does:
//   • Generates a fresh ed25519 SSH keypair in the user's app temp dir.
//   • Calls the platform's POST /api/desktop/tunnel-grant with the public
//     key + the desktop JWT (issued by /desktop/auth on sign-in).
//   • Spawns system `ssh -R 9090:127.0.0.1:9090 -i <key> -N ubuntu@<ip>`
//     with keep-alive flags so the tunnel survives idle.
//   • Watches the ssh child; on exit, refreshes the grant (the EIC key
//     window is only 60s) and reconnects with exponential backoff
//     1s → 2s → 4s → 8s → … up to 30s, then steady.
//   • On `stop()`, terminates the ssh process and wipes the temp keypair.
//
// Status events for the renderer UI:
//   'idle'        — start() not called yet, or stop() done
//   'granting'    — calling the platform API
//   'connecting'  — spawning ssh, waiting for handshake
//   'connected'   — tunnel is up
//   'reconnecting'— ssh exited; backing off before retrying
//   'error'       — terminal failure (no valid token, no workspace, etc.)
//
// Token persistence is the caller's concern. tunnel-manager only emits
// `token-refreshed` events when the grant API rotates the JWT — main.js
// listens and writes the new value into config.json.

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCAL_PORT = 9090;
const REMOTE_PORT = 9090;
const KEEP_ALIVE_INTERVAL_SEC = 30;
const KEEP_ALIVE_COUNT_MAX = 3;
const MAX_BACKOFF_MS = 30_000;

class TunnelManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => string|null} opts.getToken      Returns current JWT or null.
   * @param {(token: string) => void} opts.setToken Persists a refreshed JWT.
   * @param {() => string|null} opts.getPlatformUrl Returns platform base URL.
   * @param {(msg: string) => void} [opts.dbg]     Debug logger.
   */
  constructor({ getToken, setToken, getPlatformUrl, dbg }) {
    super();
    this.getToken = getToken;
    this.setToken = setToken;
    this.getPlatformUrl = getPlatformUrl;
    this.dbg = dbg ?? (() => {});

    /** @type {import('child_process').ChildProcess | null} */
    this.child = null;
    this.keyPath = null;
    this.pubKeyPath = null;
    this.stopped = true;
    this.backoffMs = 1000;
    this.lastStatus = 'idle';
    this.lastError = null;
    this.lastConnected = null;
  }

  status() {
    return {
      status: this.lastStatus,
      error: this.lastError,
      connectedAt: this.lastConnected,
    };
  }

  /** Start (or restart) the tunnel loop. Idempotent. */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffMs = 1000;
    void this._loop();
  }

  /** Stop the tunnel and clean up. */
  async stop() {
    this.stopped = true;
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.child = null;
    this._cleanupKey();
    this._setStatus('idle');
  }

  /* ── internals ──────────────────────────────────────────────────── */

  async _loop() {
    while (!this.stopped) {
      try {
        await this._connectOnce();
        // _connectOnce resolves when ssh exits (clean or otherwise). Reset
        // backoff because we had a successful session.
        if (this.lastConnected) this.backoffMs = 1000;
      } catch (err) {
        this.lastError = err?.message ?? String(err);
        this.dbg(`tunnel-manager: connect failed: ${this.lastError}`);
      }
      if (this.stopped) break;
      this._setStatus('reconnecting');
      await this._sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  async _connectOnce() {
    this._setStatus('granting');

    const token = this.getToken();
    const platformUrl = this.getPlatformUrl();
    if (!token || !platformUrl) {
      const err = new Error(token ? 'platformUrl missing' : 'desktop token missing');
      this._setStatus('error');
      this.lastError = err.message;
      // Without a token, retrying makes no sense — sleep long.
      await this._sleep(60_000);
      throw err;
    }

    this._ensureKey();
    const sshPublicKey = fs.readFileSync(this.pubKeyPath, 'utf8').trim();

    const grantUrl = `${platformUrl.replace(/\/$/, '')}/api/desktop/tunnel-grant`;
    const res = await fetch(grantUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sshPublicKey }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`tunnel-grant returned ${res.status}: ${text.slice(0, 200)}`);
      // 401/403: token is dead. No point retrying without a new sign-in.
      if (res.status === 401 || res.status === 403) {
        this._setStatus('error');
        this.lastError = 'sign in again — token expired';
        this.emit('token-expired');
        await this._sleep(60_000);
      }
      throw err;
    }
    const grant = await res.json();
    if (grant.refreshedToken) {
      this.setToken(grant.refreshedToken);
      this.emit('token-refreshed', grant.refreshedToken);
    }

    this._setStatus('connecting');
    await this._spawnSsh(grant);
  }

  _spawnSsh(grant) {
    return new Promise((resolve) => {
      // OpenSSH client. Windows 10+ ships it at System32\OpenSSH\ssh.exe and
      // it's on PATH. macOS/Linux: /usr/bin/ssh. We rely on PATH.
      const args = [
        '-N',
        '-R', `${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`,
        '-i', this.keyPath,
        '-o', `ServerAliveInterval=${KEEP_ALIVE_INTERVAL_SEC}`,
        '-o', `ServerAliveCountMax=${KEEP_ALIVE_COUNT_MAX}`,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        `${grant.ec2User}@${grant.ec2Ip}`,
      ];
      this.dbg(`tunnel-manager: spawn ssh ${args.join(' ')}`);

      let connected = false;
      let outBuf = '';

      const child = spawn('ssh', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      const onData = (chunk) => {
        outBuf += chunk.toString('utf8');
        // We don't really need to grep — once ssh holds the connection for
        // ~2s without exiting, we treat it as connected. ServerAlive will
        // keep it that way.
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      // Mark "connected" after a brief grace period if ssh hasn't exited.
      const graceTimer = setTimeout(() => {
        if (!child.killed && child.exitCode === null && child.signalCode === null) {
          connected = true;
          this.lastConnected = new Date().toISOString();
          this.lastError = null;
          this._setStatus('connected');
        }
      }, 2_500);

      child.once('exit', (code, signal) => {
        clearTimeout(graceTimer);
        this.child = null;
        const tail = outBuf.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        if (this.stopped) {
          resolve();
          return;
        }
        if (!connected) {
          this.lastError = `ssh exited before connect (code=${code} signal=${signal}) ${tail}`;
          this._setStatus('reconnecting');
        } else {
          this.lastError = `ssh exited after connect (code=${code} signal=${signal}) ${tail}`;
          this._setStatus('reconnecting');
        }
        this.dbg(`tunnel-manager: ssh exit ${code}/${signal} — ${tail}`);
        resolve();
      });

      child.once('error', (err) => {
        clearTimeout(graceTimer);
        this.lastError = `ssh spawn failed: ${err.message}`;
        this._setStatus('error');
        resolve();
      });
    });
  }

  _ensureKey() {
    if (this.keyPath && fs.existsSync(this.keyPath)) return;
    // Node's `crypto.generateKeyPairSync` doesn't emit OpenSSH-format
    // private keys; openssh `ssh -i` rejects pkcs8 PEMs. Easiest portable
    // way to a usable keypair is shelling out to `ssh-keygen`, which ships
    // with OpenSSH (already on PATH on Windows 10+, macOS, every Linux
    // distro we'd ever run on).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-tunnel-'));
    const keyPath = path.join(dir, 'id_ed25519');
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    if (r.status !== 0) {
      throw new Error(`ssh-keygen failed (${r.status}): ${r.stderr?.toString() ?? ''}`);
    }
    this.keyPath = keyPath;
    this.pubKeyPath = `${keyPath}.pub`;
  }

  _cleanupKey() {
    if (!this.keyPath) return;
    try {
      const dir = path.dirname(this.keyPath);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
    this.keyPath = null;
    this.pubKeyPath = null;
  }

  _setStatus(s) {
    if (this.lastStatus === s) return;
    this.lastStatus = s;
    this.emit('status', this.status());
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { TunnelManager };
