'use strict';

// Headscale mesh manager — replaces the old reverse-SSH tunnel-manager.js.
//
// The desktop's in-Electron Playwright MCP server (mcp-server.js, 127.0.0.1:9090)
// has to be reachable by the user's EC2 workspace, which lives behind NAT from
// the desktop's point of view. Instead of a reverse SSH tunnel we join a
// self-hosted Headscale tailnet:
//
//   • The platform's POST /api/desktop/mesh-grant hands back a short-lived,
//     single-use Headscale auth key + the login-server URL + this node's
//     MagicDNS hostname (desktop-<node>).
//   • `tailscale up` registers the node; `tailscale serve --tcp` exposes the
//     local MCP port (9090) to tailnet peers (needed because userspace mode has
//     no TUN for peers to dial the host directly).
//   • The EC2 backend then reaches http://desktop-<node>.<magic>:9090/ over
//     MagicDNS (provision.sh sets PLAYWRIGHT_MCP_URL).
//
// The status vocabulary, event names and constructor shape match the old
// TunnelManager so main.js / preload.js / the frontend indicator need no
// changes: 'idle'|'granting'|'connecting'|'connected'|'reconnecting'|'error',
// events 'status' | 'token-refreshed' | 'token-expired'.
//
// ── How tailscaled runs, per platform (validated against bundled v1.98.4) ──
//   Linux/macOS: we spawn the bundled `tailscaled` in USERSPACE networking mode
//     as the current user, with state + a unix-domain control socket under the
//     app's userData dir. No admin, no TUN driver. We own the process and
//     reconnect when it exits.
//   Windows: tailscaled's LocalAPI named pipe is hard-owned by LocalSystem
//     (SDDL O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)), so a non-elevated process CANNOT
//     create it. tailscaled must therefore run as a LocalSystem **service**,
//     installed once by the (elevated) app installer — see installer notes in
//     vendor/tailscale/README.md. At runtime we DON'T spawn it; we drive the
//     service's default pipe with the bundled `tailscale.exe` (no --socket).
//     Admin is required once at install, never at runtime.

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const MCP_PORT = 9090;
const MAX_BACKOFF_MS = 30_000;
const SOCKET_WAIT_MS = 15_000;
const WIN_POLL_MS = 10_000;

class MeshManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => string|null} opts.getToken        Returns current desktop JWT or null.
   * @param {(token: string) => void} opts.setToken  Persists a refreshed JWT.
   * @param {() => string|null} opts.getPlatformUrl  Returns platform base URL.
   * @param {() => string} opts.getUserDataPath      App userData dir (persistent tailscaled state).
   * @param {() => string} opts.getBinDir            Dir holding the tailscale/tailscaled binaries.
   * @param {(msg: string) => void} [opts.dbg]       Debug logger.
   */
  constructor({ getToken, setToken, getPlatformUrl, getUserDataPath, getBinDir, dbg }) {
    super();
    this.getToken = getToken;
    this.setToken = setToken;
    this.getPlatformUrl = getPlatformUrl;
    this.getUserDataPath = getUserDataPath;
    this.getBinDir = getBinDir;
    this.dbg = dbg ?? (() => {});

    /** @type {import('child_process').ChildProcess | null} */
    this.daemon = null; // posix only — on Windows the service owns the daemon
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

  /** Start (or restart) the mesh loop. Idempotent. */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffMs = 1000;
    void this._loop();
  }

  /** Stop the mesh link and clean up. Keeps the node's state dir intact. */
  async stop() {
    this.stopped = true;
    // Best-effort: drop the serve config and log out so the ephemeral node is
    // reaped promptly by Headscale.
    this._cli(['serve', 'reset'], 4000);
    this._cli(['down'], 4000);
    // Only kill the daemon we own (posix). On Windows the LocalSystem service
    // keeps running — `down` above logs the node out, which is enough.
    if (this.daemon && !this.daemon.killed) {
      try { this.daemon.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.daemon = null;
    this._setStatus('idle');
  }

  /* ── internals ──────────────────────────────────────────────────── */

  async _loop() {
    while (!this.stopped) {
      try {
        await this._connectOnce();
        if (this.lastConnected) this.backoffMs = 1000;
      } catch (err) {
        this.lastError = err?.message ?? String(err);
        this.dbg(`mesh-manager: connect failed: ${this.lastError}`);
      }
      if (this.stopped) break;
      this._setStatus('reconnecting');
      await this._sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  async _connectOnce() {
    // ── 1. Grant: refresh token + mint an ephemeral Headscale auth key ──
    this._setStatus('granting');
    const token = this.getToken();
    const platformUrl = this.getPlatformUrl();
    if (!token || !platformUrl) {
      const err = new Error(token ? 'platformUrl missing' : 'desktop token missing');
      this._setStatus('error');
      this.lastError = err.message;
      await this._sleep(60_000);
      throw err;
    }

    const grantUrl = `${platformUrl.replace(/\/$/, '')}/api/desktop/mesh-grant`;
    const res = await fetch(grantUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`mesh-grant returned ${res.status}: ${text.slice(0, 200)}`);
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
    if (!grant.loginServer || !grant.authKey || !grant.desktopHostname) {
      throw new Error('mesh-grant response missing loginServer/authKey/desktopHostname');
    }

    // ── 2. Connect: daemon → up → serve ─────────────────────────────
    this._setStatus('connecting');
    await this._ensureDaemon();

    const up = this._cli([
      'up',
      // Windows-only: keep the tunnel up after this CLI process exits. Without
      // it, tailscaled tears down the moment the "frontend" (our spawnSync)
      // disconnects, so the node never stays connected.
      ...(IS_WIN ? ['--unattended'] : []),
      `--login-server=${grant.loginServer}`,
      `--authkey=${grant.authKey}`,
      `--hostname=${grant.desktopHostname}`,
      // The desktop is the MCP server, not a consumer — don't touch the user's
      // system DNS resolver.
      '--accept-dns=false',
      '--reset',
    ], 60_000);
    if (up.status !== 0) {
      throw new Error(`tailscale up failed (${up.status}): ${this._tail(up.stderr || up.stdout)}`);
    }

    // Expose the local MCP HTTP server to tailnet peers as a raw TCP forward
    // (peer:9090 → 127.0.0.1:9090). Raw TCP keeps MCP's streaming HTTP/SSE
    // bytes untouched. Syntax verified against bundled tailscale v1.98.4:
    //   tailscale serve --bg --tcp <port> <local-target>
    const serve = this._cli([
      'serve', '--bg', '--tcp', String(MCP_PORT), `127.0.0.1:${MCP_PORT}`,
    ], 20_000);
    if (serve.status !== 0) {
      throw new Error(`tailscale serve failed (${serve.status}): ${this._tail(serve.stderr || serve.stdout)}`);
    }

    // ── 3. Connected. Resolve when the link drops → reconnect. ───────
    this.lastConnected = new Date().toISOString();
    this.lastError = null;
    this._setStatus('connected');
    await this._holdUntilDisconnected();
  }

  /**
   * Ensure tailscaled is reachable.
   *   posix:   spawn the bundled daemon in userspace mode if not already up.
   *   windows: the LocalSystem service owns the daemon — we only verify the
   *            default pipe answers. If it doesn't, the service isn't installed
   *            or isn't running (a reinstall registers it); surface that.
   */
  async _ensureDaemon() {
    if (IS_WIN) {
      const deadline = Date.now() + SOCKET_WAIT_MS;
      while (Date.now() < deadline) {
        if (this._cli(['status', '--json'], 3000).status !== null) return;
        await this._sleep(500);
      }
      throw new Error(
        'Tailscale background service is not running. Reinstall AI Workspace ' +
        'to register it (the installer sets it up — admin is needed once).'
      );
    }

    if (this.daemon && !this.daemon.killed && this.daemon.exitCode === null) {
      return; // still alive
    }
    const stateDir = this._stateDir();
    fs.mkdirSync(stateDir, { recursive: true });

    const { tailscaled } = this._bins();
    const args = [
      '--tun=userspace-networking',
      `--statedir=${stateDir}`,
      `--state=${path.join(stateDir, 'tailscaled.state')}`,
      `--socket=${this._sockPath()}`,
    ];
    this.dbg(`mesh-manager: spawn tailscaled ${args.join(' ')}`);
    const child = spawn(tailscaled, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.on('data', (c) => this.dbg(`tailscaled: ${c.toString().trim()}`));
    child.stderr?.on('data', (c) => this.dbg(`tailscaled: ${c.toString().trim()}`));
    child.once('error', (err) => this.dbg(`tailscaled spawn error: ${err.message}`));
    this.daemon = child;

    const deadline = Date.now() + SOCKET_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.daemon !== child || child.exitCode !== null) {
        throw new Error('tailscaled exited during startup');
      }
      if (this._cli(['status', '--json'], 3000).status !== null) return;
      await this._sleep(400);
    }
    throw new Error('tailscaled did not become reachable in time');
  }

  /**
   * Block until the mesh link drops, then return so _loop() reconnects.
   *   posix:   resolve when the daemon process we spawned exits.
   *   windows: the service process isn't ours, so poll `tailscale status` and
   *            resolve when the node is no longer running/online.
   */
  _holdUntilDisconnected() {
    if (!IS_WIN) {
      return new Promise((resolve) => {
        if (!this.daemon) { resolve(); return; }
        this.daemon.once('exit', (code, signal) => {
          this.daemon = null;
          if (!this.stopped) {
            this.lastError = `tailscaled exited (code=${code} signal=${signal})`;
            this.dbg(`mesh-manager: ${this.lastError}`);
          }
          resolve();
        });
      });
    }
    return new Promise((resolve) => {
      const tick = () => {
        if (this.stopped) { resolve(); return; }
        const r = this._cli(['status', '--json'], 4000);
        let down = r.status === null; // pipe unreachable → service gone
        if (!down && r.stdout) {
          try {
            const st = JSON.parse(r.stdout);
            const bad = st.BackendState && st.BackendState !== 'Running';
            if (bad) down = true;
          } catch { /* ignore parse errors, keep polling */ }
        }
        if (down) {
          this.lastError = 'tailscale link dropped';
          resolve();
          return;
        }
        this._pollTimer = setTimeout(tick, WIN_POLL_MS);
      };
      this._pollTimer = setTimeout(tick, WIN_POLL_MS);
    });
  }

  _stateDir() {
    return path.join(this.getUserDataPath(), 'tailscale');
  }

  /** Unix socket path (posix only). */
  _sockPath() {
    return path.join(this._stateDir(), 'tailscaled.sock');
  }

  /** Socket arg for the CLI. Empty on Windows → CLI uses the service's pipe. */
  _socketArgs() {
    return IS_WIN ? [] : [`--socket=${this._sockPath()}`];
  }

  /** Resolve the bundled binary paths for the current platform. */
  _bins() {
    const dir = this.getBinDir();
    const exe = IS_WIN ? '.exe' : '';
    return {
      tailscale: path.join(dir, `tailscale${exe}`),
      tailscaled: path.join(dir, `tailscaled${exe}`),
    };
  }

  /** Run a `tailscale` CLI subcommand synchronously. */
  _cli(args, timeoutMs) {
    const { tailscale } = this._bins();
    return spawnSync(tailscale, [...this._socketArgs(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
  }

  _tail(s) {
    return String(s ?? '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
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

module.exports = { MeshManager };
