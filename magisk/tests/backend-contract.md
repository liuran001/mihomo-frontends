# Backend policy contract

Run `sh magisk/tests/backend.sh` with POSIX sh, Git Bash or BusyBox ash. The suite
uses an isolated temporary module and stubs process launch/locking; it does not
contact a device, execute a downloaded core, or test real eBPF/kernel behavior.
`sh magisk/tests/backend-process.sh` separately checks real stale/foreign PID
rejection and inherited-FD closure without launching any proxy process.
`sh magisk/tests/backend-readiness.sh` exercises the actual startup readiness
loop with mocked process/network tools: absent or empty `/ebpf/summary` must stop
the service and fail; a nonempty diagnostic list succeeds. Only a 404 from an
older core permits a startup-only fallback to `/ebpf`.
`sh magisk/tests/backend-status.sh` holds the write lock while reading status:
read-only status must return promptly, without Wi-Fi probes or module writes.

- `sh policy.sh get`: JSON with `ok`, boolean `autostart`/`tethering`,
  comma-delimited `tethering_interfaces`, newline-delimited `bypass_packages` and
  `wifi_ssids`, `wifi_mode` (`off`, `only`, `exclude`), `allowed`, and `current_ssid`.
  `allowed` is true when Wi-Fi policy is off; otherwise it is the last decision
  cached by the policy watcher or a settings write. Missing/mismatched cache
  returns null, not an invented allowed/denied result. Status reads do not query
  Android Wi-Fi services; `current_ssid` can be empty or last-observed.
- `sh policy.sh ssid`: explicitly queries the current SSID and returns `ok` and
  `current_ssid`; used only by the add-current-Wi-Fi action. It may wait for
  Android, unlike read-only status.
- `sh policy.sh set AUTO TETHER INTERFACES_B64 PACKAGES_B64 WIFI_MODE SSIDS_B64`:
  switch values are `0` or `1`; empty interfaces selects
  `ap0,wlan1,rndis0,usb0,bt-pan`. Returns `{"ok":true}` or an error JSON/nonzero
  exit. Settings are committed together. A running service is restarted or
  paused; a stopped service is not started by saving settings.
- SSID comparison is literal, case-sensitive, and whitespace-preserving. Blank
  lines do not match a disconnected station. `only` denies no connection;
  `exclude` allows it. Inputs use LF-delimited UTF-8 text, no control characters,
  max 32 bytes per SSID. Ambiguous/unrecognized Wi-Fi status means disconnected.
- Manual `start`/`restart` sets a per-boot manual intent. SSID denies pause it;
  an allowed SSID resumes it even if autostart is off. Manual `stop` cancels
  intent, including autostart, until an explicit start or the next boot.
  Autostart only establishes automatic intent at boot; merely enabling the
  setting never starts a manually stopped service. Disabling a module stops it.
  Turning autostart off only affects the next boot, not existing automatic
  intent. `mihomo.sh status` adds `desired` (`manual`, `auto`, `stopped`),
  `allowed` and `current_ssid` alongside the original process fields.
- `apply.sh BASE64 restart` explicitly applies and starts, including when stopped
  (SSID still gates actual startup). Omitting `restart` only saves the source.
  Failure restores the old source and previous running/stopped intent.
  The command interface currently limits base64 configurations to 120000 bytes;
  the caller must reject oversized arguments before invoking Android `sh`.
- The source YAML remains untouched by policy. Runtime is `run/config.yaml`,
  passed with `-f`. Supported: exactly one explicit block-style `ebpf` listener,
  normal unquoted mapping keys, block role mappings, scalar/flow scalar lists.
  Multiple listeners (including mixed non-eBPF listeners), flow listeners,
  listener anchors/aliases/merges/tags, multiline scalars, duplicate keys and
  YAML documents/directives are rejected, rather than partially applying policy.
  Non-listener sections, including their anchors, are copied unchanged.
- The policy owns mode (`local`/`hybrid`), local DNS `respect_policy`,
  `local.exclude-package` and `shared.interface`. Existing values in these
  managed fields are replaced in runtime only. Role enable/enabled selectors
  are removed to avoid conflicting with mode. Other supported fields survive.
- Package bypass requires an Android core when installed. Actual support is
  checked on startup, not through a `with_ebpf` version tag. Readiness requires
  a nonempty `/ebpf/summary` response on a private controller Unix socket, with
  a 404-only fallback to `/ebpf` for older cores. The socket is
  inside root-only `run` and does not change the user's TCP controller/secret.
- Android entrypoints re-execute the installed KSU/Magisk/APatch BusyBox ash with
  standalone mode. Locks use `flock -n` on an inherited FD with bounded retry,
  released automatically on exit. Spawned core/watch processes close unrelated
  lock FDs and detach with `setsid` and all standard streams redirected.
- PID records contain PID and Linux process start ticks. Signals also verify
  executable identity and exact `-d`/runtime `-f` arguments; arbitrary stale or
  legacy PID files never trigger name-based killing.

Device integration still needs real service boot, module disable, Wi-Fi changes,
hotspot interface availability, missing/failed eBPF attachment, and real process
exit/rollback verification. Interface defaults are candidates, not a guarantee
that every Android build exposes each interface. Forced SIGKILL may prevent
the core from restoring Android netd BPF hooks; normal shutdown is preferred.

## Enhanced WebUI and screen control

- Enhanced mode is enabled only through the root-only module-manager CLI and
  Unix socket. It requires a configured main password and password access;
  browser/Tailnet passwordless access cannot substitute for a main session.
  An optional operation password creates a 15-minute, main-session-bound token.
- `GET /api/enhanced/status` returns permissions and screen settings. Only an
  unlocked caller receives `screen_service` with installed/running/ready state,
  version and last startup error. Status never starts capture or Android helpers.
- POST enhanced actions require same-origin JSON. `scrcpy-set` accepts `enabled`,
  `mode` (`builtin` or `external`), `port`, `max_size` (640–1920), `fps` (5–60) and
  `bit_rate` (256000–8000000). Empty, unknown or out-of-range changes are rejected.
  Applying settings cancels the existing built-in session; `scrcpy-stop` with an
  empty object explicitly stops it without disabling the next manual connection.
- `/enhanced/scrcpy/` and its assets require both main and operation authorization.
  In built-in mode, only an authenticated WebSocket upgrade at `stream` starts
  one scrcpy process. A second session is rejected. A random abstract Unix socket
  connects the child without ADB, Node or an additional TCP listener. Peer PID
  must match that exact child; its UID must match the owner, or shell UID 2000
  after official scrcpy drops root privileges. Arbitrary local shell peers fail.
- Screen frames use the scrcpy 5.0.1 H.264 session/frame protocol. Video packets
  are streamed rather than accumulated (2 MiB per packet); controls are strict
  JSON with an 8 KiB message limit, a 16-message queue and 180 messages/second.
  A stalled socket writer is bounded to five seconds. Input supports touch,
  allowed Android keys, rotation and explicit UTF-8 clipboard paste (4096 bytes).
- Capture is manual and single-session, audio/clipboard autosync/stay-awake are
  off, and static-frame repetition is reduced to once per second. Permission
  checks exist only for active streams (five seconds), with a 20-second missing
  pong deadline and 15-minute absolute session limit. Page hide/close disconnects;
  cancellation closes local channels and kills/reaps the child process group.
  Graceful WebUI shutdown waits a bounded time for capture cleanup.
- The browser uses WebCodecs where available and MediaSource otherwise. Decoder
  queues and MSE staging buffers have limits; stale callbacks cannot redraw after
  stop. Closing the page releases its decoder, muxer, video source and clipboard
  field. Neither mode writes video to device storage.
- `external` mode remains a bounded authenticated proxy to a separately managed
  loopback service. Its toggle does not start or kill a third-party process.

`node --test magisk/tests/screen.test.js` tests browser lifecycle and limits.
`magisk/tests/scrcpy-device-smoke.cjs` tests actual video/input and revocation
against a running, disposable Android emulator with an enabled built-in service
and independent operation password. Set `SCREEN_QA_URL`, `SCREEN_QA_PASSWORD`
and `SCREEN_QA_OPERATION_PASSWORD`; optional `SCREEN_QA_ADB` plus
`SCREEN_QA_SERIAL=emulator-PORT` verifies the Android foreground and child exit.
The ADB path refuses non-emulator serials. These checks do not measure phone power.
