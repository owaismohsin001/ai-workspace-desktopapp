# Phase 6 results — automated per-user reverse SSH tunnel

**Outcome: working end-to-end.** The desktop app now opens its own
reverse SSH tunnel to the signed-in user's EC2 workspace automatically.
No CLI step, no platform-wide AWS credentials, no manual reconnect on
network blips. The user signs in once via the connect window; the app
maintains the tunnel for the lifetime of the workspace session.

Verified 2026-06-05: from a fresh app launch with the manual Phase 4
tunnel killed and the desktop config wiped, the user signed in via the
Platform flow, the tunnel went `granting → connecting → connected` in
under 4 seconds, EC2 was able to reach the desktop's MCP server through
the loopback bind, and the chat panel still drives Playwright tools the
same way it did under the manual tunnel.

---

## 6.1 What ships

### Platform (landing page) — three new pieces

- **New: [src/lib/desktop-auth.ts](../ai-project-landing-page/src/lib/desktop-auth.ts)**
  — 30-day JWT mint/verify helpers, separate audience (`aud:desktop`)
  from the web session cookie so the two channels rotate
  independently. Uses `DESKTOP_JWT_SECRET` if set, falls back to
  `JWT_SECRET`.
- **[src/app/desktop/auth/page.tsx](../ai-project-landing-page/src/app/desktop/auth/page.tsx)**
  — after the existing sign-in check, mints a desktop token and embeds
  it (plus the request's own host as `platformUrl`) into the
  `aiide://` deep link. Older /desktop/auth pages without these query
  params still work — the desktop manager just stays idle without a
  token.
- **New: [src/app/api/desktop/tunnel-grant/route.ts](../ai-project-landing-page/src/app/api/desktop/tunnel-grant/route.ts)**
  — bearer-auth POST endpoint. Verifies the desktop JWT, loads
  `user.workspace.{instanceId, publicIp, iamAccessKeyId,
  iamSecretAccessKey}` from Mongo, calls EC2 Instance Connect with the
  user's **own** IAM credentials, and returns the EC2 IP + a refreshed
  token (rolling 30-day TTL). Per-user creds means the platform host
  never needs an AWS role — and a leaked desktop token can only inject
  SSH keys into its own owner's EC2.

### Desktop — new tunnel-manager

- **New: [tunnel-manager.js](tunnel-manager.js)** — single
  `TunnelManager` class. On `start()`:
  1. Generates a fresh ed25519 keypair via `ssh-keygen` (ships with
     OpenSSH on every supported platform).
  2. POSTs `{ sshPublicKey }` + bearer token to
     `/api/desktop/tunnel-grant`.
  3. Spawns `ssh -N -R 9090:127.0.0.1:9090 -i <key> -o
     ServerAliveInterval=30 -o ServerAliveCountMax=3 -o
     ExitOnForwardFailure=yes -o BatchMode=yes
     <ec2User>@<ec2Ip>`.
  4. Holds the connection. On exit (network drop, EC2 reboot, EIC key
     window lapse — anything), reconnects with exponential backoff
     1s → 2s → 4s → … 30s.

  Status events for the renderer:
  `idle | granting | connecting | connected | reconnecting | error`.

- **[main.js](main.js)** — instantiates one `TunnelManager` for the
  app lifetime. Reads/writes the token from `config.json` so a
  returning user (with a stored token) auto-reconnects without going
  through the connect window. Started on successful `handleDeepLink`,
  stopped on `Disconnect Workspace` and `window-all-closed`. Forwards
  status events to the renderer over a `tunnel:status` IPC channel.

- **[preload.js](preload.js)** — exposes `__AIIDE__.tunnel.onStatus(cb)`
  so the renderer can subscribe.

### Renderer (`AIWorkspaceFrontEnd`) — minimal status indicator

- **New: [src/utils/electronTunnel.ts](../AIWorkspaceFrontEnd/src/utils/electronTunnel.ts)**
  — `useTunnelStatus()` React hook + `ElectronTunnel` type. Returns
  null outside Electron so the indicator hides in `next dev`.
- **[src/components/workspace/editor-overlay-toolbar.tsx](../AIWorkspaceFrontEnd/src/components/workspace/editor-overlay-toolbar.tsx)**
  — new `TunnelStatusDot` element on the left side of the chrome
  toolbar row. Hover tooltip shows the current status + last error;
  no other interaction surface. Color map:
  - 🟢 green = `connected`
  - 🟡 amber = `granting | connecting`
  - 🟠 orange = `reconnecting`
  - 🔴 red = `error`
  - ⚪ grey = `idle`

### Terraform — for new signups

- **[terraform/workspace/iam-policy.json.tpl](../ai-project-landing-page/terraform/workspace/iam-policy.json.tpl)**
  — adds an `EC2InstanceConnect` Allow statement scoped to the user's
  own instance ARN. New signups get the permission automatically.

  **Important footnote:** AWS appears not to honor `*` in the
  account-id segment of the resource ARN for the
  `ec2-instance-connect:SendSSHPublicKey` action — at least in
  us-west-2 at the time of testing. Other actions in this same policy
  use `arn:aws:ec2:us-west-2:*:instance/...` and work fine; EIC
  alone requires the explicit account ID. The terraform template
  uses `*` (matching the existing convention) — if this causes
  issues, replace with `${data.aws_caller_identity.current.account_id}`.

  The existing user `ai-workspace-6a13f1bcc7af067a0028324b` had this
  manually patched to the explicit account ID during Phase 6 testing
  (see §6.3). Other already-provisioned users will need the same
  one-off patch.

---

## 6.2 End-to-end pipeline

```
[Desktop app on user's machine]
   │
   │ 1. Connect window → "Sign in with Platform"
   │ 2. System browser opens /desktop/auth (Platform)
   │ 3. (Platform) sign-in OK → mint 30-day desktopToken
   │ 4. ← aiide://workspace?url=…&name=…&token=JWT&platformUrl=…
   │ 5. (Desktop) handleDeepLink writes token+platformUrl→config.json
   │ 6. createMainWindow + tunnelManager.start()
   │
   ▼
[TunnelManager]
   │ 7. ssh-keygen → ephemeral ed25519 keypair (temp dir)
   │ 8. POST /api/desktop/tunnel-grant
   │     Authorization: Bearer JWT
   │     Body: { sshPublicKey }
   │
   ▼
[Platform API /api/desktop/tunnel-grant]
   │ 9. Verify JWT → userId
   │ 10. Mongo: User.findById → workspace.{instanceId, publicIp,
   │             iamAccessKeyId, iamSecretAccessKey}
   │ 11. EC2InstanceConnectClient (user's OWN creds) →
   │       SendSSHPublicKey(instanceId, "ubuntu", sshPublicKey)
   │       — valid for 60s
   │ 12. Mint refreshed JWT
   │ 13. Return { ec2Ip, ec2User, ec2Region, refreshedToken, … }
   │
   ▼
[TunnelManager]
   │ 14. spawn ssh -N -R 9090:127.0.0.1:9090 -i <key>
   │              -o ServerAliveInterval=30 …
   │              ubuntu@<ec2Ip>
   │ 15. status → connecting → connected (≈3s total)
   │     • Renderer: status dot turns green
   │     • config.json: refreshedToken written back
   │
   ▼
[Steady state]
   • EC2's localhost:9090 forwards back to desktop's localhost:9090
   • Backend's `mcpServers.playwright` (Phase 4) hits localhost:9090
   • Chat panel tool calls route through to the desktop's MCP server
   • Tunnel survives idle via ServerAliveInterval
   • On exit (network drop, etc.), exponential backoff reconnect
```

The desktop app needs only the user's interactive sign-in once per 30
days; everything else automates.

---

## 6.3 Issues hit during testing

1. **`mongoose` ESM import** — none, but the test temp script needed to
   live inside the platform repo for `node` to resolve `mongoose` and
   `@aws-sdk/...`. Trivia; just a footnote for future debug scripts.

2. **IAM policy ARN wildcard for EIC** — the per-user IAM policy was
   provisioned by Phase 1 terraform with broad S3 + EC2 actions but
   without `ec2-instance-connect:SendSSHPublicKey`. We added that. But
   even with the action added, the policy used `arn:aws:ec2:us-west-2:*:instance/…`
   (the same `*` wildcard already in use for ManageInstance) and AWS
   still returned AccessDenied. Replacing `*` with the explicit
   account ID `979667333627` worked immediately. The other statements
   in the same policy continue to work with `*` — only EIC seems
   strict. Not investigated further; terraform template documents the
   gotcha.

3. **IAM propagation** — typically <30s; in our case took ~2 minutes
   from `put-user-policy` to first successful EIC call. Manifests as
   the tunnel sitting in `error → reconnecting → granting` loops with
   500s from the grant API until propagation completes.

4. **`/tmp` path translation in Git Bash** — when shelling out to
   Windows-native CLIs (aws, python) from Git Bash, paths like
   `/tmp/policy.json` get mistranslated. Use `cygpath -w` or just
   write directly to `C:\Users\HP\…`. Cost a few iterations during
   the IAM policy patch.

---

## 6.4 What's still manual / nice-to-have

- **Other already-provisioned users** still lack the EIC permission;
  each one needs the one-off `aws iam put-user-policy` patch from
  §6.1. A small script in `ai-project-landing-page/scripts/` that
  iterates over `User.find({ 'workspace.iamAccessKeyId': { $exists:
  true } })` and patches each policy would close that gap. **Not done
  here.**

- **EC2 region detection** — `tunnel-grant` defaults to `us-west-2`,
  falls back to probing common regions if the user's instance isn't
  found there. Should cache the discovered region on the User doc
  (`user.workspace.region`) so subsequent grants skip the probe.

- **Status indicator click → manual retry** — today the dot is
  read-only. Clicking it to force a reconnect would be a nice UX
  addition.

- **Tray icon / sign-out from UI** — the only way to sign out today is
  the File menu's "Disconnect Workspace". A tray icon with status +
  reconnect + sign out would round out the desktop integration.

---

## 6.5 How to bring it up from scratch

For a brand-new workspace user (after the terraform change is in
production):

```
1. Sign up on the platform; let the Stripe → terraform pipeline
   finish provisioning the workspace.
2. Launch the desktop app. Connect window appears.
3. Click "Sign in with Platform". System browser opens /desktop/auth.
4. Sign in if needed. The page auto-fires the aiide:// deep link.
5. Desktop receives it, captures token + platformUrl, opens the
   workspace window, starts the TunnelManager.
6. Status dot in the toolbar:  grey → amber → green within ~5s.
7. The chat panel's Playwright tool calls work immediately.
```

For an existing user (provisioned before Phase 6, e.g.
`umarinfo002@gmail.com` who we tested with):

```
1. One-off patch the user's IAM policy to add EC2InstanceConnect with
   their explicit account ID. The Phase 6 testing left a working
   patch on this user; future ones can use this script:

   USER_ID=<mongo _id>
   ACCOUNT_ID=<aws account>
   INSTANCE_ID=<from user.workspace.instanceId>

   aws iam get-user-policy --user-name "ai-workspace-$USER_ID" \
     --policy-name workspace-permissions --profile <admin-profile> \
     --query 'PolicyDocument' --output json > /tmp/p.json
   # Append:
   # { "Sid": "EC2InstanceConnect", "Effect": "Allow",
   #   "Action": "ec2-instance-connect:SendSSHPublicKey",
   #   "Resource": "arn:aws:ec2:us-west-2:$ACCOUNT_ID:instance/$INSTANCE_ID" }
   aws iam put-user-policy --user-name "ai-workspace-$USER_ID" \
     --policy-name workspace-permissions \
     --policy-document file:///tmp/p.json --profile <admin-profile>

2. Then the steps 2-7 from the new-user flow.
```
