# Bundled Tailscale binaries

`mesh-manager.js` uses bundled `tailscale` + `tailscaled` to join the user's
self-hosted Headscale tailnet and expose the local Playwright MCP port. These
binaries are NOT in git (too large) — drop them here before building.

**Pinned version: 1.98.4** (the `serve` CLI syntax is version-sensitive; it was
verified against this build). Keep all platforms on the same version.

## Layout

Resolved at runtime by `getBinDir()` in `main.js` (dev) and bundled via
per-platform `extraResources` in `package.json` (release):

```
vendor/tailscale/
  win/{x64,arm64}/    tailscale.exe   tailscaled.exe
  mac/{x64,arm64}/    tailscale        tailscaled
  linux/{x64,arm64}/  tailscale        tailscaled
```

You only need the platforms/arches you actually build. **Currently present:**
`win/x64` and `linux/x64` (fetched from the 1.98.4 release).

## How tailscaled runs (differs by OS — important)

- **Linux / macOS**: `mesh-manager.js` spawns `tailscaled` in
  `--tun=userspace-networking` mode as the normal user, with a unix-domain
  control socket under the app's userData dir. No admin, no TUN driver.

- **Windows**: two constraints, both verified the hard way. (1) tailscaled's
  LocalAPI named pipe is hard-owned by LocalSystem (SDDL
  `O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)`), so a non-elevated process cannot create it.
  (2) Windows service-mode tailscaled does NOT honor `--tun=userspace-networking`
  — it always uses a real TUN via `wintun.dll`. So the elevated NSIS installer
  registers `tailscaled.exe` as a LocalSystem **service** in normal TUN mode
  (`build/installer.nsh`); the service auto-installs the wintun network adapter
  on first run, exactly like the official Tailscale client. **`wintun.dll` MUST
  sit next to `tailscaled.exe`** in `win/<arch>/`. At runtime the app drives the
  service's default pipe with `tailscale.exe` (no admin); `--operator=$USERNAME`
  is set at install so the non-admin user can.

## Where to get them

- **Linux** (`linux/<arch>/`): `tailscale_1.98.4_<arch>.tgz` from
  https://pkgs.tailscale.com/stable/ contains `tailscale` + `tailscaled`.
  `chmod +x` them.
- **Windows** (`win/<arch>/`): extract from the MSI without installing —
  `msiexec /a tailscale-setup-1.98.4-<arch>.msi /qn TARGETDIR=<dir>`, then copy
  `PFiles64/Tailscale/tailscale.exe`, `tailscaled.exe`, AND `wintun.dll` (all
  three — wintun.dll is required for the TUN adapter).
- **macOS** (`mac/<arch>/`): Tailscale does NOT publish standalone CLI binaries
  for redistribution. Options: build `tailscale`/`tailscaled` from source
  (`go build tailscale.com/cmd/...`), or extract from the open-source
  `tailscaled` macsys variant. **TODO — not yet sourced.**

## Still to validate (no Windows-install / mac available in dev)

- Windows: the `installer.nsh` `sc.exe create` service registration + that a
  non-admin `tailscale up`/`serve` works against the service pipe end-to-end.
- macOS: userspace `tailscaled` as a normal user with a unix socket.
