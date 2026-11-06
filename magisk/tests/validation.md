# Magisk / KernelSU validation

## Environment

- Date: 2026-11-04.
- Source core: `liuran001/mihomo`, commit `e272b9d2`.
- Host: `baka@10.0.0.88`, `/Volumes/data/HyperOS-AVD`.
- Guest: `emulator-5580`, HyperOS 4 / Android 17, arm64, kernel `6.6.66-android15-8`, KernelSU `v3.3.0 (32601-2)`, SELinux Enforcing.
- Release core downloaded by the module: `alpha-smart-e272b9d-ebpf`, Android arm64, Go 1.26.10.
- A separate locally compiled Android arm64 core with `with_gvisor with_ebpf` also passed basic cgroup interception.

No existing mihomo module or data directory was present before installation. Other installed modules were left unchanged.

## Automated regression

```sh
node --test magisk/tests/frontend.test.js
sh magisk/tests/core.test.sh
sh magisk/tests/backend.sh
sh magisk/tests/backend-process.sh
sh magisk/tests/backend-readiness.sh
```

The frontend suite exercises the actual application JavaScript with mocked DOM and native bridge. Backend pure tests cover settings, SSID parsing/matching, rendering, input rejection, apply/restore rollback and service intent. Locking and process launch are mocked only in the portable backend suite; the device tests below exercise real KernelSU locks, processes and eBPF.

## Earlier backend / HTML WebUI device results

| Check | Observed result |
| --- | --- |
| Install ZIP with `ksud module install` | Installed successfully; boot activation and script permissions verified |
| Release download | `/releases/latest` is 404; falls back to latest prerelease and downloads the Android arm64 asset successfully |
| Startup readiness | `/ebpf` on the private controller socket reports a nonempty cgroup inbound |
| Local interception | With `MATCH,REJECT`, shell curl to `http://1.1.1.1` changes from HTTP 301 to empty reply / HTTP 000 |
| Package bypass | Adding `com.android.shell` resolves UID 2000 and restores HTTP 301 while the core continues running |
| Tethering off/on/off | Downstream namespace traffic through veth `mh-test0`: HTTP 301 → rejected / HTTP 000 → HTTP 301 |
| Exact SSID deny | `exclude` + `AndroidWifi` stops interception and reports `allowed:false` |
| Exact SSID allow | `only` + `AndroidWifi` resumes the previously requested service |
| Actual Wi-Fi disconnect/reconnect | Under `only`, disabling Wi-Fi pauses the core; reconnecting resumes it automatically |
| Manual stop | Saving settings and waiting for polling does not restart a manually stopped service |
| Autostart on | Real guest reboot starts the core with automatic intent |
| Autostart off | Turning it off preserves the current service; another real reboot leaves the core stopped |
| Module disable | `ksud module disable mihomo-ebpf` causes the watcher to stop the core; re-enabling does not unexpectedly start it |
| Runtime failure rollback | An invalid eBPF data plane passes the core's configuration test but fails attachment; readiness detects the failure, returns an error, restores the exact source checksum and restarts the previous core |
| Native WebUI | Opened from KernelSU; overview renders real process state/version/controller, and settings show persisted package/SSID/shared-interface values |
| Android shell compatibility | WebUI-style `sh ...` re-executes BusyBox ash; bounded `flock -n` works with the installed BusyBox, unlike unsupported `flock -w` or mksh-inherited FDs |
| Windows package | ZIP entries use `/`, UTF-8 without BOM and LF, with no development server or test code included |

## Compose Miuix UI review (2026-11-05)

- `wasmJsBrowserDistribution` compiles the actual Miuix 0.9.4 Kotlin/Wasm UI. No legacy HTML/CSS UI is included in the ZIP.
- `node --test magisk/tests/bridge.test.js magisk/tests/frontend.test.js`: 90 tests pass. The second suite protects the legacy bridge behavior, not Compose rendering.
- `magisk/tests/webui-smoke.cjs` drives the production bundle with Playwright and an explicitly mocked bridge. It checks the application bottom sheet, cancel, help dialog, SSID save payload, dark mode and 320px layout. Screenshots go to `dist/ui-review/`. It requires Playwright (`PLAYWRIGHT_MODULE` optionally selects an existing installation), a Chromium executable (`CHROME_PATH` optional), and the production directory served at `http://127.0.0.1:8765` (`WEBUI_URL` optional). It does not install browser packages or start a server automatically.
- All non-local browser requests are blocked in this test. The full bundled Noto Sans CJK SC font renders Chinese without Google Fonts/CDN. An environment-injected Kaspersky script request is separately reported, blocked, and excluded from the application-resource assertion.
- Compose canvas owns pointer hit-testing; tests use positions from semantic bounds to click through the canvas, with settling time for Miuix overlay animations. After dismissing an overlay the tested Compose version can temporarily omit underlying accessibility nodes; subsequent test clicks use previously measured bounds. This does not establish screen-reader compatibility.
- The production WebUI was deployed to `/data/adb/modules/mihomo-ebpf/webroot` on the same HyperOS AVD, preserving the backend and all configuration. Native overview shows the installed core and stopped service. UI review does not repeat the earlier traffic-interception/reboot tests.
- Final AVD screenshots (`avd-overview.png`, `avd-settings.png`, `avd-apps.png` in `dist/ui-review/`) verify the safe-area layout, two-column interface selection and native application labels/icons in the selection sheet. The user category displayed 46 results; existing selections were retained. Bottom navigation and sheet cancel/confirm controls are above the gesture bar. No settings were saved and the proxy service was not started during this visual pass.
- On this specific AVD, a Vulkan Manager process repeatedly produces a blank WebGL surface and Chromium shared-image/fence errors. Temporarily setting `debug.hwui.renderer=skiagl` only while launching the Manager, then restoring its original `skiavk` value, yields visible UI. Repeating Vulkan/OpenGL launch reproduces blank/visible results. The property is global during that short test window; the module never applies this workaround. Manager restart on that AVD needs the test workaround again. This is not a general device fix.
- The old canvas pixel probe was removed: it reported transparency even while UI was visibly rendered and cannot be used as proof of drawing failure. Debug overlays and the red test block are not shipped.

## Scope and reproduction cautions

- Tethering was verified with a real network namespace/veth forwarding path, not a physical Wi-Fi hotspot client or USB/Bluetooth peripheral. OEM tethering offload and interface naming still need hardware-specific validation.
- Tests used a synthetic reject policy, not a user's subscription or a live upstream proxy account. IPv6 forwarding was not covered by this AVD scenario.
- `avd-tethering.sh` is specific to this disposable AVD and `fixtures/android.yaml`. It temporarily creates a namespace, veth, routes, forwarding and iptables rules to simulate a downstream client, and cleans up its own network state. The production module does not install these iptables rules. Do not run the script on a production phone or with unrelated routing table 109 rules.
- Settings support a single block-style eBPF listener. Unsupported YAML is rejected explicitly; see `backend-contract.md`.
- The AVD is left with the module installed but service/autostart disabled. A minimal DIRECT smoke-test configuration remains, not a subscription configuration.

## v1.2.0 on HyperOS AVD (2026-11-05)

Device: `emulator-5580` HyperOS 4 / Android 17, kernel 6.6.66 (BTF, cgroup2), KernelSU 32601, core `alpha-smart-e272b9d-ebpf`. Data was backed up to `HyperOS-AVD/tmp/mihomo-test/backup-before-v1.2.0.tgz` and the original `config.yaml`, service state and Manager settings were restored afterwards.

- `ksud module install` of the v1.2.0 zip keeps the existing config; `customize.sh` only appends missing settings keys (existing `autostart=0`, `tethering=1` kept).
- `tests/device-check.sh` (root shell): `host.sh probe`, a 288000-byte stage round trip in 96000-byte chunks, `fetch` of a 143 KB GitHub config, rejection of `file://`.
- Real WebView checks went through CDP (`tests/cdp-eval.mjs`, with Manager's WebView debugging enabled temporarily via `tests/avd-webdebug.sh`):
  - `tests/device-flow.js`: MetaCubeX example config → analyze (54 proxies, 20 listeners) → optimize → idempotent re-run with no required changes. The example itself fails `mihomo -t` because of placeholder values (`server: [YOUR_SERVER_IP]`) and `/path/to/ui`, so that pass is not a validation pass.
  - `tests/device-flow-template.js`: subscription → built-in template → optimize, and a router-style config (tproxy, TUN, absolute `/etc/openclash` paths, `PROCESS-NAME`) → optimize. Both pass `mihomo -t` on the device.
  - Applying the optimized template with restart started the core; `/ebpf` reported a hybrid inbound (cgroup + packet_rewrite) and the home page showed live traffic.
- UI driven via `tests/avd-ui.sh` (KernelSU WebUIActivity is not exported; launched from the Manager module list with the temporary `skiagl` workaround):
  - Wizard steps 1–3 with a real host probe and a real config URL.
  - Home, proxies (32 groups in config order, with delays), settings and the app picker with real packages and icons.
  - System back closes sheets, then returns to the previous page, and from home exits the WebUI.

Bugs found and fixed on device:
- Lists did not scroll by touch. WebView took the pan and sent `pointercancel`; fixed with `touch-action: none` on the Compose host.
- `importUrl` always failed. KernelSU runs commands in a persistent libsu shell, so a top-level `exit` reports failure; the command now runs in a subshell.
- Upstream detection found `dummy0` and IPv6 detection found a link-local route. Android uses per-network routing tables; detection now uses `ip route get`, and IPv6 requires a global source address.
- Imported configs with absolute paths were rejected by the core's SAFE_PATHS check. A required optimize step now rewrites them to relative paths.
- A URL pasted into the YAML box is now treated as a subscription.
- The overview no longer blanks values during refresh, and long core version strings are shortened.

Not covered: real hotspot/USB clients through the shared data plane, IPv6-capable networks, other OEM WebViews, and the wizard's apply step driven by touch (the same calls were exercised through CDP).

## Tailscale web login on HyperOS AVD (2026-11-05)

Same device and core. `config.yaml` and `settings.ini` were backed up to `HyperOS-AVD/tmp/mihomo-test/backup-before-tailscale.tgz` and restored afterwards; the `tailscale/` state directory created by the test was removed and the service was left stopped as before.

- Probe with an isolated core (`/data/local/tmp/tstest`, port 19190, `log-level: warning`, a tailscale outbound without `auth-key`): subscribing to `/logs?level=info` over plain HTTP and then requesting `/proxies/TS/delay` printed `To start this tsnet server, … go to: https://login.tailscale.com/a/…`. Before login `tailscaled.state` contains only `_machinekey`.
- Through CDP in the real WebView: `tailscale.add` → `validate` (real core) → `apply` with restart → `service start` → `tailscaleLogin` returned a login URL in 4.1 s and `qrCode` a 29×29 matrix. A second `tailscaleLogin` without restart returned no URL (tsnet prints it once), `restart` then `tailscaleLogin` returned a new URL, and `tailscaleLogout` stopped the core, removed the state directory, started it again and a new login URL was available.
- UI on device: Settings → Tailscale shows the outbound; 网页登录 without a fresh tsnet shows the restart hint, 重启服务后重新获取 shows the QR code and URL, 在浏览器打开 starts `com.android.browser` with the URL.

Not covered: completing a real Tailscale account login (needs the user's account), traffic to Tailnet peers after login, and the LuCI flow on a router (covered by backend tests with the real core and a frontend unit test only).

## Web management loading and identity regressions (2026-11-05)

- JavaScript regressions cover session, logout and script requests that stall before headers or during JSON decoding, with and without AbortController. The deadline settles the bridge independently of transport cancellation; expired sessions redirect to login, and failed logout does not report success.
- Tailscale refresh reads and parses the configuration once, builds only Tailscale fields, and skips controller/state requests when there are no Tailscale outbounds. Running outbounds use live identity only; missing login data and NeedsLogin no longer inherit an old account from disk. NotStarted and missing live outbounds retain the current saved profile, selected by `_current-profile`, not the first profile.
- Synthetic desktop benchmark (204,251-byte YAML, 500 rule providers, 5,000 rules, one Tailscale outbound): the full schema took 921–1,313 ms per call; Tailscale-only extraction took 43–61 ms. The old refresh built the full schema twice. This is not a phone timing measurement.
- `webui-loading-smoke.cjs` uses the production UI and preview backend with both `tailscaleRead` and `webuiSession` deliberately left pending. It verifies that refresh sends another status request, the port editor opens, and pending secondary requests are not duplicated. Run the preview server, then `WEBUI_URL=http://127.0.0.1:8790/ node magisk/tests/webui-loading-smoke.cjs`; `PLAYWRIGHT_MODULE` and `CHROME_PATH` may select an existing installation.
- No Android device was connected during this regression work. Device ownership, actual installed core responses, OEM WebView behavior and switching a real Tailscale account are not verified; no device login state or network settings were modified.

## Control-plane isolation, enhanced controls and resource review (2026-11-06)

This pass runs on desktop Linux/Windows with mocked Android services. Earlier AVD results in this file do not validate the new enhanced controls or establish a phone power measurement.

### Core regressions

- A non-consuming log subscriber reproduced a blocked producer with the old implementation. The regression publishes 5,000 events without draining the subscriber; the updated log-only lossy observable completes without waiting for the consumer. Ordinary observables retain reliable delivery, local logging retains the configured level, and info subscriptions no longer turn on debug formatting.
- Tailscale status reads a small independent snapshot, not the startup mutex or LocalAPI/WireGuard status. Lock-contention tests verify reads remain available while startup is blocked; cancelled startup waiters return without starting duplicate backends. The existing IPN watcher supplies initial identity and subsequent self changes. Account selection matches `Self.User` to `UserProfile.ID`, and NeedsLogin clears stale identity.
- Core tests: `SKIP_INTEROP_TEST=1 go test -tags 'with_gvisor with_ebpf' -timeout 180s ./...` passes (89 packages with tests, 106 without). The flag skips the external VMess interoperability suite. A previous concurrent run hit an HTTP/2 SETTINGS timeout in the unrelated Trojan/Reality/gRPC test; the isolated retry and final whole-tree run pass. The changed outbound, provider, observable, log, route, statistic, eBPF and listener packages also pass `-race`; relevant `go vet` checks pass.
- Desktop microbenchmarks: Tailscale status approximately 393 ns/op and 392 B/op; connection summaries for 0, 1,000 and 10,000 records have zero allocations and approximately 34–87 ns/op. These are request-helper measurements, not Android end-to-end latency or energy savings.

### Frontend and backend checks

- Production `wasmJsBrowserDistribution` builds successfully with Kotlin 2.4.20, Compose 1.12.0 and Miuix 0.9.4. The five bridge/config/onboarding/frontend/login JavaScript suites pass all 188 tests. `magisk/webd` passes its full Go race suite and `go vet`.
- Shell checks pass: 112 backend policy checks; real stale/foreign PID and inherited descriptor checks; mocked core readiness; status reads under a held write lock without Wi-Fi probes or module writes; 26 Tailscale checks; 27 host-WebUI checks; 79 discovery checks; core/install-preset checks. No user's config, login, network, hotspot or SMS data is used.
- Controller HTTP/WebSocket tests verify the authenticated `/clash/` proxy, injected controller secret, private-header stripping, redirects, and session logout. Already-open controller WebSockets close within the 5-second revalidation interval. Enhanced tests cover the main-password requirement, local-manager-only configuration, rejection of TCP-loopback impersonation and `/api/run` bypass, independent operation-password sessions, revocation, invalid-config fail-closed behavior, bounded concurrency, terminal timeout/output/process-group cleanup, and scrcpy socket revocation.
- `home-performance-smoke.cjs` passes against the production bundle with 10,000 mocked connections: no full connection/proxy/provider/map requests for the overview; hidden pages stop polling; resume uses summaries; detailed eBPF is manual; 404 from old cores does not trigger a heavy fallback. The tested home text requires no Google Fonts fallback; arbitrary names outside the bundled subset may still need fallback fonts.
- `webui-loading-smoke.cjs` passes while `tailscaleRead` and `webuiSession` remain unresolved: refresh still submits status requests, the port dialog opens, and secondary reads are not duplicated.
- `live-smoke.cjs` passes both scenarios: 2,000 proxy nodes mount 16 initial / 30 scrolled node semantics, while 240 connection records display the latest 200 and initially mount eight rows. Refresh failures preserve snapshots but prevent writes; empty IDs cannot disconnect, duplicate IDs do not cause duplicate writes. Counts are mounted accessibility nodes, not an instrumented recomposition count.
- `enhanced-smoke.cjs` passes at 1,440px and 393px: operation-password gate, on-demand battery/SMS reads, clear-message display, confirmed terminal payload, and lock action. Returned terminal text and cleared locked state are visually checked in screenshots. Separate proxy screenshots confirm the child strategy icon is present on both widths, using the same configured image as the parent.
- Compose 1.12.0 can retain stale accessibility nodes after overlays close or rows detach. Synthetic `dispatchEvent('click')` on an obsolete semantics node raises a detached-Modifier exception; real pointer tests pass without those exceptions. Tests use real pointer interaction, isolate popup scenarios by reload, and use screenshots plus backend-call assertions where popup semantics remain stale. This is not a screen-reader compatibility claim. The connections sheet retains its content until its close animation completes.

### Final resource audit

- Magisk overview uses a visible-only 2-second summary loop and approximately 30-second metadata/maintenance refresh; connections use a visible-only 5-second loop, paused during details. Tailscale login polling cancels on close/navigation and waits while hidden. Enhanced data is loaded only on action, never on a device polling daemon.
- `webd` streams precompressed assets produced by packaging; it no longer gzip-compresses Wasm or retains large Wasm copies per server at runtime. The package contains 14 gzip/plain pairs with identical decompressed bytes. Missing/stale compressed files safely fall back to their plain files. Icon caches are bounded, decoding concurrency is limited, and SVG temporary objects are released.
- Shell status reads consume the policy cache rather than probing Wi-Fi or writing module metadata. The existing policy supervisor still checks service/SSID conditions every five seconds; Wi-Fi-off policy avoids `cmd wifi` and `dumpsys`, and unchanged policy snapshots are not rewritten. This remaining watchdog is intentional for recovery/SSID response, not zero overhead.
- Device commands are temporary and bounded: two device operations, one terminal command, two password verifications and eight scrcpy requests at a time. Terminal execution is capped at 60 seconds and bounded output; ordinary child processes are cleaned up. WebSocket permission checks run only while their connections exist. Scrcpy is a proxy entry, not an installed recording service or an automatically started daemon.
- LuCI was also found polling full connections and map diagnostics on its overview. It now uses the same summary endpoints, serializes periodic reads, stops polls/streams when hidden or detached, resumes after visibility/back-forward-cache restoration, and tears down the real-time log stream on the system-log tab. The 17 frontend suites and syntax checks pass, including new lifecycle, no-overlap, HTTP-body deadline, 404-no-heavy-fallback and live-identity tests. LuCI router deployment was not performed.
- Existing eBPF maintenance remains necessary: interface repair is event-driven with a 10-minute drift recheck; datapath diagnostics read fixed counters every 30 seconds only when a data plane exists; bounded UDP/state cleanup follows the existing timeout design. Tailscale networking, health checks explicitly configured by the user and active traffic still consume resources. No whole-device current, temperature, throughput-under-UI-load or battery-life measurement was performed.

### Local artifacts and hardware boundaries

- PowerShell packaging succeeds with the production WebUI, both static webd architectures and the Android device-control DEX. The ZIP has 57 unique entries, normalized LF shell scripts, exact production assets and no tests. The Linux packaging path was not completed because the local host lacks `zip`; its shell source passes syntax checks.
- `dist/mihomo-ebpf-magisk-v1.2.0.zip`: 19,794,027 bytes; SHA-256 `6890078d0d5344cd41d3e7a770e055c94ed74ae6d0dc6ef632361b21c834cf2a`.
- `dist/mihomo-android-arm64-webui-perf-test.gz`: 23,477,211 bytes; SHA-256 `d56df1af0c8169a9016331d752afcd6858715a01467fbd67cc223e4edfdd6171`. It contains a 68,404,832-byte Android ARM64/API 28 executable built with NDK 27 and `with_gvisor with_ebpf`, version label `webui-perf-test`. This is a local build of the current dirty checkout, not an upstream release, an APK or a flashable module.
- The module does not include the mihomo core. Update module and core together; installing only the module leaves old-core blocking paths unchanged. Keep the existing config and a backup of the working core. No artifact was installed on a device in this pass.
- Not verified on hardware: real Tailnet login/ownership changes; carrier/OEM SMS permissions and hotspot/tethering callbacks; real ws-scrcpy video/input and device power use. Hotspot control requires Android 11/API 30+ and may be rejected by OEM permission policy. The user must provide a compatible loopback ws-scrcpy service with `WS_SCRCPY_PATHNAME=/enhanced/scrcpy/`. Enhanced control is root-equivalent after authorization, not a sandbox; public exposure is strongly discouraged.

## Complete built-in screen control and Android integration (2026-11-06)

This follow-up supersedes the preceding pass's external-service-only scrcpy
limitation and module ZIP fingerprint. The original results remain above as a
historical record. No user-owned phone, account, SMS database or network settings
were used. A new disposable `MihomoEnhancedQA20261106` AVD, Android 15/API 35,
Google APIs x86_64 with SELinux enforcing, ran the actual Go webd and Android
helpers; Chromium connected through a temporary ADB forward. ADB was test
transport only: the installed feature itself does not depend on ADB or Node.

### Functionality completed

- The module includes official scrcpy 5.0.1, JMuxer 2.1.4, the web client and
  third-party notices. Both build scripts fetch pinned, SHA-256-checked assets
  and reuse valid caches. The device never downloads these dependencies.
- Built-in mode starts `app_process` only after an authorized user clicks
  connect. Video and input use a random abstract Unix socket and the existing
  authenticated WebUI WebSocket. Exact child PID and permitted UID checks apply;
  scrcpy 5.0.1 intentionally drops root to shell UID 2000, which is accepted only
  for that child. No new TCP listener, ADB server or Node daemon is introduced.
- Browser controls include single-pointer touch/drag, home/back/recent tasks,
  power/volume keys, rotation, explicit Unicode clipboard paste and fullscreen.
  Resolution, frame rate and bit rate are configurable within bounds. Default
  1280/24 fps/2 Mbps disables audio, clipboard autosync and keep-awake. Existing
  ws-scrcpy installations remain available through explicit external mode.
- One encoder/session is allowed, capped at 15 minutes. Page hide/close stops
  capture; locking or logout revokes open streams within five seconds, missing
  pongs expire in 20 seconds, and stalled writes have deadlines. Settings changes
  cancel the old session. No automatic background reconnect or recording occurs.

### Actual Android results

- Battery returns actual emulator system data: 100%, powered, 25 C. SMS initially
  returns an empty list; an emulator-injected `QA-SMS-EMULATOR-ONLY` message from a
  test number is then returned with its text, date and address. No real SMS is read.
- Saving a test WPA2 hotspot configuration, enabling it, reading state and
  disabling it all return success through the real Android helper. AP state
  changes from disabled 11 to enabled 13 and back to 11; tethering reports active
  during use. Client association, mobile-data routing and OEM ROM support are not
  established by this emulator test.
- The authorized root terminal executes `printf QA_ANDROID_TERMINAL` and returns
  the expected output; desktop regressions additionally test timeout, output caps
  and child process-group cleanup.
- `scrcpy-device-smoke.cjs` passes with real H.264 frames in WebCodecs at 1440px
  and MediaSource at 393px. Both display 576 x 1280 frames, send touch gestures and
  home keys, and verify Android actually changes from Settings to its launcher.
  Changing max size to 960 changes the rendered longest side accordingly.
- The same test verifies no automatic start, refusal of a simultaneous second
  session, hidden-page stop without auto-resume, closed-page stop, settings-change
  stop, independent operation-password lock and main logout. Android `ps` confirms
  no scrcpy process remains after each completed stop/revocation.
- A separate graceful-shutdown test starts a real encoder, verifies its complete
  `app_process ... com.genymobile.scrcpy.Server` command, sends SIGTERM to the test
  webd, and confirms both processes exit and the browser disconnects (246 ms in
  this sample). Process checks use command arguments rather than `ps NAME`, which
  reports `app_process` instead of the Java class on this Android image.
- A separate non-loopback HTTP hostname test reports `isSecureContext=false`,
  `VideoDecoder=undefined`, and working MediaSource video. Compatibility mode is
  therefore checked on a genuinely insecure HTTP origin, not just by hiding the
  WebCodecs API on localhost. This is not a claim of network encryption: use
  Tailscale or HTTPS for untrusted transport.

### Resource and regression checks

- Static-frame repeats are reduced from scrcpy's default 100 ms to 1 second,
  only while explicitly connected. Quiet screens do not trigger forced reconnects.
  The server streams each bounded packet instead of queueing complete videos;
  control rate, packet size, concurrency and output are bounded. Browser decoder
  backlog stops the session; MSE staging over 4 MiB stops rather than growing
  indefinitely, old buffered playback is cleaned, and stop releases all players.
- An idle 20-second Android sample after repeated sessions shows unchanged webd
  user/system CPU ticks (46/12), unchanged read/write syscall counters and unchanged
  disk I/O bytes, with 11,136 KiB RSS and nine threads before/after. No recording
  or device helper process remains. This is an emulator webd sample, not a phone
  current measurement, a core throughput benchmark or a zero-overhead guarantee.
- Final webd `go vet ./...` and full `go test -race -count=1 ./...` pass (29.9 s).
  New regressions cover child credentials, missing/corrupt assets, repeated failed
  startup cleanup, single-session reservation, bounded shutdown, control encoding,
  settings limits and build-time asset verification.
- All 199 JavaScript tests pass, including screen lifecycle, stale decoder
  callbacks, authorization cancellation, packet/clipboard bounds, MSE backlog and
  explicit-stop routing. Compose production builds, wide/narrow enhanced UI smoke,
  indefinitely pending WebUI/TS reads and summary-only/hidden home checks pass.
  The 17 LuCI suites and syntax checks pass. Module shell regressions also pass;
  install preset tests pass after explicitly assigning binary/resource permissions.
- Core code is unchanged by this follow-up; the preceding whole-core and race
  results still apply. The overall resource review retains the intentional
  policy watchdog, configured health checks and Tailscale/eBPF network maintenance,
  rather than presenting necessary networking as removable WebUI overhead.

### Updated delivery

- `dist/mihomo-ebpf-magisk-v1.2.0.zip`: 20,790,441 bytes; SHA-256
  `602e510864be384bd1a10954fd21bd4d4f2686f6dea4d46c1657264d5f50767a`.
  PowerShell build succeeds. Verification checks 62 unique entries, 14 matching
  gzip/plain pairs, both ELF architectures, the device-control DEX, exact current
  production WebUI files, scrcpy/JMuxer hashes, all notices and LF shell scripts.
- The matching Android ARM64 core remains
  `dist/mihomo-android-arm64-webui-perf-test.gz`, 23,477,211 bytes; SHA-256
  `d56df1af0c8169a9016331d752afcd6858715a01467fbd67cc223e4edfdd6171`.
  Update both module and core to obtain the earlier blocking-path fixes.
- Remaining hardware boundaries: real Tailnet account ownership/switching,
  device/OEM permissions and encoders, hotspot clients and routing, DRM capture,
  sustained device throughput, heat and battery consumption. No full Magisk flash
  or user-device deployment is performed in this follow-up. Enhanced access is
  root-equivalent, and public exposure remains strongly discouraged.
- The disposable emulator, its AVD files, temporary ADB forward and preview server
  on 8790 are removed/stopped after validation. The pre-existing service on 8793
  is not changed.
