# Device command protocol v1

A paired device makes outbound HTTPS requests to DurableClaw. No listening port,
SSH server, tunnel, shared owner token, or root daemon is required on the Mac.
Each device owns an Ed25519 private key. The Worker stores only its public key.
The device key authorizes its own poll/result endpoints; it never authorizes an
owner API, enrollment-code creation, approvals, or command submission.

Deploy `migrations/0003_devices.sql` to the existing `CONTROL_DB` before enabling
these routes. The main router must authenticate owner requests and supply the
live `run_device_bash` policy callback to `routeDevicePublic`. An absent or false
callback cancels pending jobs and returns 403. A callback exception fails closed
with 503. All responses use `Cache-Control: no-store`.

## Enrollment

1. An authenticated owner sends `POST /api/devices/enrollment` with
   `{"name":"My Mac"}`. Response 201 contains `{code, expires_at}`. The code is
   32 cryptographically random bytes encoded as unpadded base64url; only its
   SHA-256 digest is stored. It expires after 10 minutes and can be used once.
2. The daemon generates an Ed25519 key pair locally. `public_key` is standard
   base64 encoding of the DER SPKI public key. The private key stays on the Mac.
3. The daemon sends `POST /api/devices/enroll` with
   `{code, public_key, proof}`. `proof` is a standard-base64 Ed25519 signature of
   this exact UTF-8 string, with no trailing newline:

   ```text
   durableclaw-enroll-v1\n{code}\n{public_key}
   ```

   Response 201 contains `{device_id}`. The server verifies proof of possession
   and current owner authority before atomically inserting the device and
   consuming the enrollment code. Invalid, expired, reused codes and invalid
   proofs return 401. Enrollment is not automatically retried after an ambiguous
   response; the owner can inspect/revoke a possibly registered device and
   create a fresh enrollment.

Device names are 1–128 UTF-8 bytes without control characters. There are at most
10 pending enrollments and 100 registered device records per owner/workspace,
including revoked devices. Codes are bearer secrets during enrollment: keep
them out of chat messages, shell history, logs, and URLs.

## Signed requests

`POST /api/devices/poll` takes exactly `{}`. `POST /api/devices/result` takes a
result object described below. Both require:

| Header               | Value                                         |
| -------------------- | --------------------------------------------- |
| `X-Device-Id`        | Registered device UUID                        |
| `X-Device-Timestamp` | Decimal Unix milliseconds, within ±60 seconds |
| `X-Device-Nonce`     | New UUID for every request, including retries |
| `X-Device-Signature` | Standard-base64 Ed25519 signature             |

The signed UTF-8 text is the following, without a trailing newline:

```text
durableclaw-device-v1\n{device_id}\n{HTTP_METHOD}\n{origin+pathname+search}\n{timestamp}\n{nonce}\n{sha256hex(raw_body)}
```

The hash is lowercase hexadecimal SHA-256 over the exact UTF-8 request body.
JSON serialization, method, query, host, and scheme must match the submitted
request. Do not follow redirects with device credentials. TLS is mandatory;
`LOCAL_DEV=true` permits HTTP only on `localhost`, `127.0.0.1`, or `[::1]`.
Nonces are inserted atomically and retained through the full timestamp validity
window, including future-dated requests. Revocation and live owner authority
are checked on every signed request. At most 500 live nonces per device are
accepted; revoked, replayed, malformed or rate-limited credentials return 401.

## Command authorization and lifecycle

`list_devices` identifies targets. `run_device_bash` requires `device_id`, exact
`command`, absolute `cwd`, and integer `timeout_ms`. Its preview describes the
machine and full command. A session-authenticated web approval binds all these
arguments, the tool version and conversation. Telegram and other messaging
plugins can request this preview but cannot approve it.

The confirmation coordinator consumes an approval once. The D1 queue also has a
unique owner/workspace/confirmation constraint. There is intentionally no public
HTTP enqueue API or exposed tool `directExecute` bypass. The tool rechecks live
owner authority and revocation at enqueue; polling rechecks owner authority,
revocation, and the current persona tool policy before claiming.

Consumption in the conversation Durable Object and queue insertion in D1 are
not one transaction. A crash between them can consume approval without creating
a job. This fails safely: inspect job history and ask for a fresh approval; never
blindly rerun an ambiguous execution. A consumed approval does not authorize an
automatic second execution.

Poll returns `{job:null}` or:

```json
{
  "job": {
    "job_id": "UUID",
    "claim_id": "UUID",
    "device_id": "UUID",
    "command": "printf hello",
    "cwd": "/Users/example",
    "timeout_ms": 30000,
    "expires_at": 1790000000000
  }
}
```

A single atomic update claims a queued job. Claimed jobs are never redelivered,
even when the poll response is lost. `expires_at` is the latest permitted start
time, five minutes after enqueue. The device must reject an expired job, persist
a local claim journal before spawning bash, and never replay a command marked
started after a crash. Accepted claims have `timeout_ms + 60 seconds` from claim
time to report a result. After that they become `unknown`, indicating that
execution may have occurred. Unknown jobs require explicit fresh approval to
run again.

Limits are 16,000 UTF-8 bytes per command, 4,096 bytes per absolute directory,
1–120,000 ms timeout, and 30 queued/claimed jobs per device. Timeout cannot roll
back completed effects or guarantee termination of processes that deliberately
escape the daemon process group. This interface grants the installed macOS
user's full permissions; it is not a shell sandbox.

## Results

A result is:

```json
{
  "job_id": "UUID",
  "claim_id": "UUID",
  "stdout": "hello",
  "stderr": "",
  "exit_code": 0,
  "signal": null,
  "timed_out": false,
  "truncated": false
}
```

`exit_code` is null or an integer 0–255. `signal` is null or a POSIX signal name
such as `SIGTERM`. Optional `error` describes daemon failure, including unknown
outcome after restart, and is limited to 4,096 UTF-8 bytes. Combined stdout and
stderr are limited to 65,536 UTF-8 bytes. JSON request bodies are bounded to
512 KiB to accommodate escaped output. Poll bodies are bounded to 1 KiB;
enrollment bodies to 4 KiB.

First successful upload returns 200 `{ok:true}`. Resending the same normalized
result for the same device/job/claim returns 200 `{ok:true,duplicate:true}`.
Different output, a wrong device/claim, an unknown job, or an expired claim
returns 409; the daemon must stop retrying that result and must not execute the
command again. Invalid result fields return 400; oversized bodies return 413.
503 indicates temporary service failure and permits retrying result upload with
a fresh signed nonce. Command output is untrusted data and should not become
instructions or enter broad telemetry.

## Owner APIs and retention

| Method and path                | Result                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `GET /api/devices`             | `{devices:[...]}`; scoped owner/workspace metadata, no public/private credentials      |
| `DELETE /api/devices/:id`      | `{ok:true}`; revoke device, cancel queued jobs, remove nonce records                   |
| `GET /api/devices/jobs`        | `{jobs:[...]}`; newest 200 jobs with compact `result_summary`, excluding stdout/stderr |
| `GET /api/devices/jobs/:id`    | `{job:{...}}`; one full job with `result` including stdout/stderr                      |
| `DELETE /api/devices/jobs/:id` | `{ok:true}` for unclaimed/cancelled jobs, 409 once claimed                             |

Revocation prevents new claims and result acceptance. It cannot stop a command
already running offline; stop the LaunchAgent locally to terminate its process.
Job status is one of `queued`, `claimed`, `completed`, `cancelled`, `expired`, or
`unknown`. A completed job can still represent a command failure; inspect its
exit code, signal, timeout and error. Terminal history retains at most 200 jobs
per owner/workspace and seven days, swept on queue activity/history access.
Pairing tokens and request nonces are also swept during activity.

For the D1 primitives used here, see Cloudflare's [prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
and [batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
