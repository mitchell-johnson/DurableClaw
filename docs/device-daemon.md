# macOS device daemon

The device daemon lets DurableClaw run approved bash commands on each paired Mac. It makes outbound HTTPS requests and opens no listening port. Each installation generates its own Ed25519 key. The owner token and Cloudflare account credentials are never stored on the Mac by this daemon.

Commands run with the installing user's full filesystem, network, and application permissions. This is intentional remote shell access, not a sandbox. Install only on Macs and user accounts you intend DurableClaw to control. Do not use `sudo`.

## Pair and install

1. Deploy the Worker and apply its device database migration. Authenticate to DurableClaw as the owner. Create a one-use enrollment code with `POST /api/devices/enrollment` and JSON `{"name":"MacBook"}`. The response contains `code` and `expires_at`. Use a different enrollment for each Mac. Keep that short-lived code private.
2. On the target Mac, install Node.js 22.12 or newer and obtain a trusted copy of this repository. From its root, run:

   ```sh
   node device-daemon/cli.mjs pair --server https://claw.example.com
   ```

   Replace the example origin with the deployed server's HTTPS origin. Paste the enrollment code at the hidden prompt. It can also be supplied through stdin; do not put it in command arguments or shell history. Pairing generates the key locally and sends the public key plus a signed proof to the server. If enrollment fails after a network interruption, inspect the owner device list, revoke any incomplete registration, and issue a fresh code. Enrollment is not automatically replayed.

3. Inspect the installation and then start the service:

   ```sh
   node device-daemon/cli.mjs install --dry-run
   node device-daemon/cli.mjs install
   node device-daemon/cli.mjs status
   ```

   `install` copies the self-contained `.mjs` runtime into `~/Library/Application Support/DurableClaw/runtime` and loads `~/Library/LaunchAgents/com.durableclaw.device.plist`. The plist records the current absolute Node executable path. Re-run `install` after changing that path or updating the daemon's source. No npm dependencies are needed by the daemon itself.

The service is a user LaunchAgent and runs while that user is logged in; logout stops it. A sleeping or disconnected Mac cannot receive new commands. This follows [Apple's LaunchAgent lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

For a first check, ask DurableClaw to list devices and propose `pwd` on the named Mac. Review the exact device, command, directory, and timeout in the authenticated web app or linked Telegram approval card. After approval, inspect the asynchronous job result. Telegram approval is limited to the exact reviewed command and expires after ten minutes; ordinary chat replies cannot approve it.

## Storage and execution

The installation directory and journal directory require mode `0700`; the private PKCS8 PEM key, config, and journal files use `0600`. The daemon refuses symlink state directories, symlink private files, and private files with broader permissions or a different owner. Do not copy the state directory to another Mac: enroll that Mac separately instead.

The daemon signs the device ID, method, full origin/path/query, timestamp, nonce, and SHA-256 digest of the exact JSON body for each poll or result request. Redirects are rejected. Normal polling is approximately every three seconds. Connection errors back off to one minute, and authentication failures pause requests for one minute before rechecking.

Each command uses `/bin/bash --noprofile --norc -c`, no interactive stdin, and a controlled environment containing `HOME`, `USER`, `LOGNAME`, `PATH`, `LANG`, and `TMPDIR`. Shell startup files and the daemon's inherited secrets are not passed to the command. Use an absolute working directory or leave it unset to use the user's home. Commands are limited to 16,000 characters, 120 seconds, and 65,536 combined stdout/stderr UTF-8 bytes. Excess output is marked truncated. A timeout or graceful shutdown sends TERM and then KILL to the shell's process group.

The journal is synced before process creation. Results are persisted before upload. After a restart, finished results are uploaded again without rerunning commands; a job recorded as started with no result is reported as having an unknown outcome. The server's stale-claim response is recorded as terminal. Acknowledged journal entries discard command output and are removed after seven days. Pending output remains private locally until accepted or rejected by the server.

There is no exactly-once guarantee for OS process side effects across crashes. Never automatically resubmit an uncertain command. Inspect its effects and obtain a fresh approval before retrying. A privileged shell command can intentionally escape its process group, launch background services, read the same user's private files, or alter the daemon. A crash or forced kill can leave child processes running. These controls protect command admission and normal execution management; they do not isolate a malicious approved command. The control-plane Worker and the Mac user account remain trusted.

## Revoke and uninstall

Revoke a device using the owner-authenticated `DELETE /api/devices/{device_id}` endpoint. Revocation prevents new claims and accepted results for that device; it does not remotely stop a command already running. Stop the local LaunchAgent to terminate an active command through graceful shutdown:

```sh
node device-daemon/cli.mjs uninstall
```

This removes the LaunchAgent and preserves pairing and journal data. To remove those files as well, revoke the server registration first and then run:

```sh
node device-daemon/cli.mjs uninstall --purge
```

Uninstalling locally does not revoke the server registration. You can invoke the installed CLI at `~/Library/Application Support/DurableClaw/runtime/cli.mjs` if the repository is no longer present; quote that path because it contains spaces. A purged device must be paired again with a new enrollment code.

## Troubleshooting

- `status` reports whether launchd has loaded the service and whether local pairing exists. It does not prove the server currently accepts the key; inspect the owner device's last-seen time for connectivity.
- Generic connection/authentication errors appear in `~/Library/Application Support/DurableClaw/daemon.log`. Command text, output, pairing codes, and keys are not written there. The log has no automatic rotation; stop the service before rotating it and preserve mode `0600`.
- For interactive diagnostics, uninstall without `--purge`, then run `node device-daemon/cli.mjs run`. Ctrl-C shuts it down gracefully. Run `install` to resume launchd management. Only one daemon may use a state directory at a time.
- An authentication error can indicate revocation, owner access changes, an incorrect server origin, or clock skew. Correct the system clock and verify owner access. Keep the device endpoints reachable through Cloudflare's edge: browser-only Access login redirects on `/api/devices/enroll`, `/api/devices/poll`, or `/api/devices/result` are rejected. These endpoints authenticate enrollment proofs or device signatures instead of a browser session.
- If Node was removed or moved by an upgrade, re-run `install` from a working Node executable. Permission errors require restoring user ownership and restrictive directory/file permissions; do not solve them by running as root.
- A stale PID lock is recovered automatically when its process is no longer alive. A crash during the brief startup lock operation can leave `.startup-lock`; the daemon refuses to guess. Stop launchd, verify no daemon or pairing process remains, and remove that empty directory before restarting. Never delete a live daemon's lock or pending job journals.
- Local development alone can use `pair --server http://127.0.0.1:8787 --allow-local-http`. The flag is persisted for that installation and only permits loopback HTTP. Production HTTPS is always the default. The Worker must also permit its explicit local-development mode.

## Verification

From the repository root:

```sh
node --test tests/device-daemon/*.test.mjs
```

The tests exercise protocol signatures, origin/redirect controls, bounded responses and output, execution environment, process-group timeout/shutdown, crash journals, revoked/stale result responses, enrollment proof, private file modes, and launchd generation/copying through an injected command runner. Test fixtures use temporary directories. They do not pair a real device, install a real LaunchAgent, or claim deployment validation.
