package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func jsonText(t *testing.T, value obj) string {
	t.Helper()
	data, err := marshalPlain(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func expectJSON(t *testing.T, value obj, err error, want string) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := jsonText(t, value); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func expectError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

// stubFetch 按地址返回固定内容，并记录请求过的地址
func stubFetch(t *testing.T, responses map[string]string) *[]string {
	t.Helper()
	var mutex sync.Mutex
	requested := &[]string{}
	saved := fetchBytes
	fetchBytes = func(maxTime int, urls ...string) ([]byte, error) {
		for _, address := range urls {
			mutex.Lock()
			*requested = append(*requested, address)
			mutex.Unlock()
			if body, ok := responses[address]; ok {
				return []byte(body), nil
			}
		}
		return nil, errors.New("下载失败")
	}
	t.Cleanup(func() { fetchBytes = saved })
	return requested
}

func TestOrderedJSON(t *testing.T) {
	value := okObj(field{"b", "<x>&\"\n"}, field{"a", nil}, field{"list", []obj{{{"n", 1}}}})
	if got := jsonText(t, value); got != `{"ok":true,"b":"<x>&\"\n","a":null,"list":[{"n":1}]}` {
		t.Fatal(got)
	}
}

func TestSettingsReadWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.ini")
	if settingGet(path, "core_repo", "fallback") != "fallback" {
		t.Fatal("missing file must use fallback")
	}
	os.WriteFile(path, []byte("autostart=1\ncore_mirror=old\ncore_mirror=older\nother=x\n"), 0o600)
	if got := settingGet(path, "core_mirror", ""); got != "old" {
		t.Fatalf("first match wins, got %q", got)
	}
	if settingGet(path, "core", "none") != "none" {
		t.Fatal("prefix of a key must not match")
	}
	if err := settingsPut(path, dir, [2]string{"core_mirror", "https://m/"}, [2]string{"core_tag", ""}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "autostart=1\nother=x\ncore_mirror=https://m/\ncore_tag=\n" {
		t.Fatalf("settings = %q", data)
	}
	for _, bad := range [][2]string{{"bad key", "x"}, {"", "x"}, {"key", "a\nb"}, {"key", "a\rb"}, {"key", "\x7f"}} {
		if settingsPut(path, dir, bad) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left: %v", entries)
	}
}

func TestAssetForABI(t *testing.T) {
	cases := []struct{ abi, goarch, want string }{
		{"arm64-v8a", "arm", "android-arm64"},
		{"armeabi-v7a", "arm64", "android-armv7"},
		{"armeabi", "arm64", "android-armv7"},
		{"x86_64", "arm64", "android-amd64"},
		{"", "arm64", "android-arm64"},
		{"", "arm", "android-armv7"},
		{"", "amd64", "android-amd64"},
		{"x86", "386", ""},
	}
	for _, item := range cases {
		got, ok := assetFor(item.abi, item.goarch)
		if got != item.want || ok != (item.want != "") {
			t.Fatalf("assetFor(%q, %q) = %q %v", item.abi, item.goarch, got, ok)
		}
	}
}

func TestSelectAssetAndVersion(t *testing.T) {
	release, err := parseRelease([]byte(`{"tag_name":"T","assets":[
		{"browser_download_url":"https://example.org/mihomo-linux-arm64-v1.gz"},
		{"browser_download_url":"https://example.org/mihomo-android-arm64.sha256"},
		{"browser_download_url":"https://example.org/mihomo-android-arm64-v8-alpha-ebpf.gz"},
		{"browser_download_url":"https://example.org/mihomo-android-armv7-alpha-ebpf.gz"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := selectAsset(release, "android-arm64"); got != "https://example.org/mihomo-android-arm64-v8-alpha-ebpf.gz" {
		t.Fatal(got)
	}
	if got := selectAsset(release, "android-armv7"); got != "https://example.org/mihomo-android-armv7-alpha-ebpf.gz" {
		t.Fatal(got)
	}
	if got := selectAsset(release, "android-amd64"); got != "" {
		t.Fatal(got)
	}
	versions := map[[2]string]string{
		{"https://e/mihomo-android-arm64-v8-alpha-smart-0cc66a1-ebpf.gz", "android-arm64"}: "alpha-smart-0cc66a1-ebpf",
		{"https://e/mihomo-android-amd64-alpha-smart-0cc66a1-ebpf.gz", "android-amd64"}:    "alpha-smart-0cc66a1-ebpf",
		{"https://e/mihomo-android-armv7-alpha-smart-0cc66a1-ebpf.gz", "android-armv7"}:    "alpha-smart-0cc66a1-ebpf",
		{"https://e/mihomo-android-arm64-v8-v1.19.0.gz", "android-arm64"}:                  "v1.19.0",
	}
	for input, want := range versions {
		if got := releaseVersion(input[0], input[1]); got != want {
			t.Fatalf("releaseVersion(%q) = %q, want %q", input[0], got, want)
		}
	}
}

func TestFetchReleaseFallback(t *testing.T) {
	base := "https://api.github.com/repos/liuran001/mihomo/releases"
	requested := stubFetch(t, map[string]string{base + "?per_page=1": `[{"tag_name":"Prerelease-Alpha"}]`})
	release, err := fetchRelease("liuran001/mihomo", "", "")
	if err != nil || release.TagName != "Prerelease-Alpha" {
		t.Fatalf("release = %+v, %v", release, err)
	}
	if strings.Join(*requested, " ") != base+"/latest "+base+"?per_page=1" {
		t.Fatalf("requested %v", *requested)
	}
	// 指定 tag 时不退回到最新版本；镜像在前、直连在后
	*requested = nil
	if _, err := fetchRelease("liuran001/mihomo", "missing tag", "https://m/"); err == nil {
		t.Fatal("explicit tag must not fall back")
	}
	if strings.Join(*requested, " ") != "https://m/"+base+"/tags/missing%20tag "+base+"/tags/missing%20tag" {
		t.Fatalf("requested %v", *requested)
	}
}

func TestCoreSettings(t *testing.T) {
	env := toolEnv{data: t.TempDir()}
	result, err := coreSettings(env, "-", "-", "https://ghfast.top/")
	expectJSON(t, result, err, `{"ok":true}`)
	result, err = coreCommand(env, []string{"get_settings"})
	expectJSON(t, result, err, `{"ok":true,"repo":"liuran001/mihomo","tag":"","mirror":"https://ghfast.top/"}`)
	result, err = coreSettings(env, "owner/repo", "v1", "-")
	expectJSON(t, result, err, `{"ok":true}`)
	result, err = coreCommand(env, []string{"get_settings"})
	expectJSON(t, result, err, `{"ok":true,"repo":"owner/repo","tag":"v1","mirror":""}`)
	_, err = coreSettings(env, "bad repo", "-", "-")
	expectError(t, err, "下载设置格式无效")
	_, err = coreSettings(env, "a/b", "x\ny", "-")
	expectError(t, err, "下载设置格式无效")
	_, err = coreSettings(env, "a/b", "-", "ftp://m/")
	expectError(t, err, "镜像地址必须使用")
}

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func gzipBytes(t *testing.T, data string) []byte {
	t.Helper()
	var out bytes.Buffer
	writer := gzip.NewWriter(&out)
	writer.Write([]byte(data))
	writer.Close()
	return out.Bytes()
}

func TestCoreCheckDownloadRollback(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("需要运行 shell 脚本作为假内核")
	}
	env := toolEnv{data: t.TempDir()}
	savedABI, savedDownload := cpuABI, downloadFile
	t.Cleanup(func() { cpuABI, downloadFile = savedABI, savedDownload })
	cpuABI = func() string { return "arm64-v8a" }
	if _, err := curlPath(); err != nil {
		bin := t.TempDir()
		writeScript(t, filepath.Join(bin, "curl"), "exit 1\n")
		t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	asset := "https://example.org/mihomo-android-arm64-v8-alpha-new-ebpf.gz"
	stubFetch(t, map[string]string{
		"https://api.github.com/repos/liuran001/mihomo/releases/latest": `{"tag_name":"Prerelease-Alpha","assets":[{"browser_download_url":"` + asset + `"}]}`,
	})
	payload := gzipBytes(t, "#!/bin/sh\necho 'Mihomo Meta alpha-new-ebpf android arm64 with go1.27'\n")
	var downloads []string
	downloadFile = func(maxTime int, dest string, urls ...string) error {
		downloads = append(downloads, urls...)
		return os.WriteFile(dest, payload, 0o600)
	}

	result, err := coreCheck(env)
	expectJSON(t, result, err, `{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"","update_available":true}`)
	expectJSON(t, coreInfo(env), nil, `{"ok":true,"installed":false}`)

	writeScript(t, env.bin(), "echo 'Mihomo Meta alpha-old-ebpf android arm64 with go1.27'\n")
	result, err = coreCheck(env)
	expectJSON(t, result, err, `{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"alpha-old-ebpf","update_available":true}`)

	result, err = coreDownload(env, false)
	expectJSON(t, result, err, `{"ok":true,"version":"alpha-new-ebpf","tag":"Prerelease-Alpha"}`)
	if len(downloads) != 1 || downloads[0] != asset {
		t.Fatalf("downloads %v", downloads)
	}
	if coreVersion(env.binPrev()) != "alpha-old-ebpf" {
		t.Fatal("old core must be kept for rollback")
	}
	expectJSON(t, coreInfo(env), nil, `{"ok":true,"installed":true,"version":"Mihomo Meta alpha-new-ebpf android arm64 with go1.27","can_rollback":"yes"}`)

	result, err = coreDownload(env, false)
	expectJSON(t, result, err, `{"ok":true,"unchanged":true,"version":"alpha-new-ebpf","tag":"Prerelease-Alpha"}`)
	result, err = coreCheck(env)
	expectJSON(t, result, err, `{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"alpha-new-ebpf","update_available":false}`)

	// 回滚是对调：再回滚一次回到新版本
	result, err = coreRollback(env)
	expectJSON(t, result, err, `{"ok":true}`)
	if coreVersion(env.bin()) != "alpha-old-ebpf" || coreVersion(env.binPrev()) != "alpha-new-ebpf" {
		t.Fatal("rollback must swap current and previous")
	}

	// 镜像在前；Linux 内核不能装
	settingsPut(env.settings(), "", [2]string{"core_mirror", "https://m/"})
	payload = gzipBytes(t, "#!/bin/sh\necho 'Mihomo Meta x linux arm64'\n")
	downloads = nil
	_, err = coreDownload(env, true)
	expectError(t, err, "需要可运行的 Android 内核")
	if len(downloads) != 2 || downloads[0] != "https://m/"+asset {
		t.Fatalf("downloads %v", downloads)
	}
	if coreVersion(env.bin()) != "alpha-old-ebpf" {
		t.Fatal("rejected core must not replace the installed one")
	}
	payload = []byte("not gzip")
	_, err = coreDownload(env, true)
	expectError(t, err, "解压失败")
	entries, _ := os.ReadDir(env.runDir())
	for _, entry := range entries {
		if entry.Name() != "backend.lock" {
			t.Fatalf("temporary file left: %s", entry.Name())
		}
	}

	os.Remove(env.binPrev())
	_, err = coreRollback(env)
	expectError(t, err, "没有可回滚的旧版本")
}

func TestCoreBusyLock(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock 只在 Linux 上生效")
	}
	env := toolEnv{data: t.TempDir()}
	unlock, err := env.lockBackend()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	saved := backendLockTimeout
	backendLockTimeout = 100 * time.Millisecond
	defer func() { backendLockTimeout = saved }()
	_, err = coreSettings(env, "-", "-", "-")
	expectError(t, err, "后台忙")
}

func manifestJSON(code, url, sha string) string {
	return fmt.Sprintf(`{"version":"V9","versionCode":%s,"zipUrl":"%s","changelog":"https://c","zipSha256":"%s","luci":{"version":"0"}}`, code, url, sha)
}

func TestParseManifest(t *testing.T) {
	good := downloadPrefix + "V9/mihomo-ebpf-magisk-V9.zip"
	sha := strings.Repeat("a", 64)
	manifest, err := parseManifest([]byte(manifestJSON("26110801", good, sha)))
	if err != nil || manifest.code != 26110801 || manifest.version != "V9" || manifest.changelog != "https://c" {
		t.Fatalf("%+v %v", manifest, err)
	}
	if manifest, err := parseManifest([]byte(manifestJSON(`"7"`, good, sha))); err != nil || manifest.code != 7 {
		t.Fatalf("quoted code: %+v %v", manifest, err)
	}
	bad := map[string]string{
		manifestJSON(`"x"`, good, sha):                       "格式不对",
		manifestJSON("-1", good, sha):                        "格式不对",
		manifestJSON("1", "https://evil.example/x.zip", sha): "不是本项目的 release",
		manifestJSON("1", downloadPrefix+"V9/x.tar", sha):    "不是本项目的 release",
		manifestJSON("1", downloadPrefix+"../x.zip", sha):    "地址无效",
		manifestJSON("1", downloadPrefix+"a b.zip", sha):     "地址无效",
		manifestJSON("1", good, strings.Repeat("A", 64)):     "sha256",
		manifestJSON("1", good, "abc"):                       "sha256",
		"not json":                                           "格式不对",
	}
	for input, want := range bad {
		_, err := parseManifest([]byte(input))
		expectError(t, err, want)
	}
}

func TestModuleCheckAndUpgrade(t *testing.T) {
	env := toolEnv{data: t.TempDir(), moddir: t.TempDir()}
	os.WriteFile(filepath.Join(env.moddir, "module.prop"), []byte("id=mihomo-ebpf\nversion=V1\r\nversionCode=100\n"), 0o644)
	if _, err := curlPath(); err != nil {
		t.Skip("没有 curl")
	}
	zipURL := downloadPrefix + "V2/mihomo-ebpf-magisk-V2.zip"
	zip := []byte("PK fake zip")
	sum := sha256.Sum256(zip)
	requested := stubFetch(t, map[string]string{manifestURL: manifestJSON("200", zipURL, hex.EncodeToString(sum[:]))})
	settingsPut(env.settings(), "", [2]string{"core_mirror", "https://m/"})

	result, err := moduleCommand(env, []string{"check"})
	expectJSON(t, result, err, `{"ok":true,"current":"V1","current_code":100,"latest":"V9","latest_code":200,"update_available":true,"changelog":"https://c"}`)
	if (*requested)[0] != "https://m/"+manifestURL {
		t.Fatalf("mirror first: %v", *requested)
	}
	result, err = moduleCommand(env, []string{"current"})
	expectJSON(t, result, err, `{"ok":true,"current":"V1","current_code":100}`)

	if runtime.GOOS != "linux" {
		return
	}
	savedADB, savedDownload := adbDir, downloadFile
	t.Cleanup(func() { adbDir, downloadFile = savedADB, savedDownload })
	adbDir = t.TempDir()
	served := zip
	downloadFile = func(maxTime int, dest string, urls ...string) error { return os.WriteFile(dest, served, 0o600) }
	writeScript(t, filepath.Join(adbDir, "ksud"), `echo "args: $*" >"`+adbDir+`/calls"; echo '- 新版本已立即生效'`+"\n")
	result, err = moduleUpgrade(env, false)
	expectJSON(t, result, err, `{"ok":true,"version":"V9","live":true}`)
	calls, _ := os.ReadFile(filepath.Join(adbDir, "calls"))
	if string(calls) != "args: module install "+filepath.Join(env.runDir(), "module-update.zip")+"\n" {
		t.Fatalf("installer called with %q", calls)
	}
	if _, err := os.Stat(filepath.Join(env.runDir(), "module-update.zip")); err == nil {
		t.Fatal("downloaded zip must be removed")
	}

	served = []byte("tampered")
	_, err = moduleUpgrade(env, false)
	expectError(t, err, "sha256 不符")

	served = zip
	writeScript(t, filepath.Join(adbDir, "ksud"), "echo one; echo two; echo 'bad zip'; exit 1\n")
	_, err = moduleUpgrade(env, false)
	expectError(t, err, "安装失败：one two bad zip")

	os.WriteFile(filepath.Join(env.moddir, "module.prop"), []byte("version=V9\nversionCode=200\n"), 0o644)
	result, err = moduleUpgrade(env, false)
	expectJSON(t, result, err, `{"ok":true,"unchanged":true,"version":"V9"}`)
}

func TestTailscaleState(t *testing.T) {
	env := toolEnv{data: "/data/adb/mihomo"}
	for _, bad := range []string{"/etc/ts", "/data/adb/mihomo", "/data/adb/mihomo/", "/data/adb/mihomo/../x", "/data/adb/mihomo/a/../../x", "/data/adb/mihomo/./x", "relative"} {
		_, err := tailscaleState(env, bad)
		expectError(t, err, "状态目录必须在数据目录之内")
	}
	env.data = t.TempDir()
	dir := env.data + "/tailscale"
	result, err := tailscaleState(env, dir)
	expectJSON(t, result, err, `{"ok":true,"exists":false}`)
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte(`{
  "_current-profile": "cHJvZmlsZS1kZWE4",
  "_machinekey": "bWFjaGluZWtleS1zZWNyZXQ=",
  "_profiles": "eyJkZWE4Ijp7fX0=",
  "profile-dea8": "cHJpdmF0ZQ=="
}`), 0o600)
	result, err = tailscaleState(env, dir)
	expectJSON(t, result, err, `{"ok":true,"exists":true,"current":"cHJvZmlsZS1kZWE4","profiles":"eyJkZWE4Ijp7fX0="}`)
	os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte(`{"_current-profile":"bad\"value","_profiles":5}`), 0o600)
	result, err = tailscaleState(env, dir)
	expectJSON(t, result, err, `{"ok":true,"exists":true,"current":"","profiles":""}`)
}

// fakeController 与真实内核一样：登录日志在测速唤醒 tsnet 之后才出现，然后保持连接
func fakeController(t *testing.T, stream string) (*httptest.Server, *[]string) {
	t.Helper()
	var mutex sync.Mutex
	seen := &[]string{}
	delay := make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		*seen = append(*seen, request.Header.Get("Authorization")+" "+request.URL.RequestURI())
		mutex.Unlock()
		if strings.HasSuffix(request.URL.Path, "/delay") {
			once.Do(func() { close(delay) })
			return
		}
		writer.WriteHeader(http.StatusOK)
		writer.(http.Flusher).Flush()
		select {
		case <-delay:
		case <-request.Context().Done():
			return
		}
		writer.Write([]byte(stream))
		writer.(http.Flusher).Flush()
		<-request.Context().Done()
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func TestTailscaleLogin(t *testing.T) {
	stream := `{"type":"info","payload":"[Tailscale](Other) To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/other"}
{"type":"info","payload":"[Tailscale](TS B) LocalBackend state is NeedsLogin; running StartLoginInteractive..."}
{"type":"info","payload":"[Tailscale](TS B) To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/10972d5101d712"}
`
	server, seen := fakeController(t, stream)
	result, err := tailscaleLoginLink(server.URL, "TS%20B", "TS B", "5", "s3 cret")
	expectJSON(t, result, err, `{"ok":true,"url":"https://login.tailscale.com/a/10972d5101d712"}`)
	joined := strings.Join(*seen, "\n")
	if !strings.Contains(joined, "Bearer s3 cret /logs?level=info") ||
		!strings.Contains(joined, "Bearer s3 cret /proxies/TS%20B/delay?url=http%3A%2F%2F100.100.100.100&timeout=8000") {
		t.Fatalf("requests:\n%s", joined)
	}

	server, _ = fakeController(t, `{"type":"info","payload":"[Tailscale](TS B) AuthLoop: state is Running; done"}`+"\n")
	result, err = tailscaleLoginLink(server.URL, "TS%20B", "TS B", "5", "")
	expectJSON(t, result, err, `{"ok":true,"url":null,"running":true}`)

	server, _ = fakeController(t, "")
	started := time.Now()
	result, err = tailscaleLoginLink(server.URL, "TS", "TS", "1", "")
	expectJSON(t, result, err, `{"ok":true,"url":null,"running":false}`)
	if time.Since(started) > 4*time.Second {
		t.Fatal("login must give up after the wait time")
	}

	for _, item := range []struct{ ctl, path, name, wait, want string }{
		{"http://10.0.0.1:9090", "TS", "TS", "5", "控制器地址必须是本机"},
		{"http://127.0.0.1.evil:9090", "TS", "TS", "5", "控制器地址必须是本机"},
		{"http://127.0.0.1:9090", "a/b", "TS", "5", "出站名编码无效"},
		{"http://127.0.0.1:9090", "TS", "TS", "x", "等待时间无效"},
		{"http://127.0.0.1:9090", "TS", "TS", "-1", "等待时间无效"},
		{"http://127.0.0.1:9090", "TS", "", "5", "缺少出站名"},
	} {
		_, err := tailscaleLoginLink(item.ctl, item.path, item.name, item.wait, "")
		expectError(t, err, item.want)
	}
}

func TestNetHelpers(t *testing.T) {
	cases := map[string]int{
		"mixed-port: 7890\nport: 1\n": 7890,
		"port: '7891'\n":              7891,
		"  mixed-port: 1\nport: 2\n":  2,
		"mixed-port: 0\nport: 3\n":    3,
		"mixed-port: 99999\n":         0,
		"":                            0,
	}
	for config, want := range cases {
		if got := proxyPort(config); got != want {
			t.Fatalf("proxyPort(%q) = %d, want %d", config, got, want)
		}
	}
	for output, want := range map[string]int{"204 0.123456": 123, "200 0.0001": 1, "000 5.0": 0, "": 0, "200 x": 0} {
		if got := siteMillis(output); got != want {
			t.Fatalf("siteMillis(%q) = %d, want %d", output, got, want)
		}
	}
}

func TestNetCommand(t *testing.T) {
	if _, err := curlPath(); err != nil {
		t.Skip("没有 curl")
	}
	env := toolEnv{data: t.TempDir()}
	os.WriteFile(env.config(), []byte("mixed-port: 7890\n"), 0o600)
	saved := curlRun
	t.Cleanup(func() { curlRun = saved })
	var mutex sync.Mutex
	var calls []string
	curlRun = func(timeout time.Duration, args ...string) string {
		mutex.Lock()
		calls = append(calls, strings.Join(args, " "))
		mutex.Unlock()
		switch args[len(args)-1] {
		case "https://www.gstatic.com/generate_204":
			return "204 0.25"
		case "https://myip.ipip.net/json":
			return "{\"ip\":\"1.2.3.4\"}\r\n"
		case "https://ipwho.is/":
			return `{"ip":"5.6.7.8"}`
		}
		return "000 0"
	}
	result, err := netCommand(env, []string{"netcheck"})
	expectJSON(t, result, err, `{"ok":true,"via":"proxy","sites":[{"name":"百度","ms":0},{"name":"Google","ms":250},{"name":"GitHub","ms":0},{"name":"YouTube","ms":0}]}`)
	if !strings.Contains(strings.Join(calls, "\n"), "--proxy http://127.0.0.1:7890") {
		t.Fatalf("calls %v", calls)
	}
	os.Remove(env.config())
	calls = nil
	result, err = netCommand(env, []string{"exitip"})
	expectJSON(t, result, err, `{"ok":true,"via":"direct","cn":"{\"ip\":\"1.2.3.4\"}","intl":"{\"ip\":\"5.6.7.8\"}"}`)
	if !strings.Contains(strings.Join(calls, "\n"), "--noproxy *") {
		t.Fatalf("calls %v", calls)
	}
}

func TestReleaseCommand(t *testing.T) {
	env := toolEnv{data: t.TempDir()}
	tags := "https://api.github.com/repos/lanyi233/node-android-build/releases/tags/node-android-arm64-24"
	stubFetch(t, map[string]string{
		"https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest": `{"tag_name":"2.19.0"}`,
		tags: `{"assets":[
			{"browser_download_url":"https://github.com/x/releases/download/t/node-android-arm64-24.2.0.tar.xz"},
			{"browser_download_url":"https://github.com/x/releases/download/t/node-android-arm64-24.10.1.tar.xz"},
			{"browser_download_url":"https://github.com/x/releases/download/t/node-android-arm64-24.9.9.tar.xz"},
			{"browser_download_url":"https://github.com/x/releases/download/t/node-android-arm-24.20.0.tar.xz"},
			{"browser_download_url":"https://github.com/x/releases/download/t/node-android-arm64-24.30.0.tar.xz.sha256"}]}`,
	})
	if got, err := releaseCommand(env, []string{"tag", "sub-store-org/Sub-Store"}); err != nil || got != "2.19.0" {
		t.Fatalf("tag = %q %v", got, err)
	}
	if got, err := releaseCommand(env, []string{"tag", "sub-store-org/Missing"}); err != nil || got != "" {
		t.Fatalf("missing tag = %q %v", got, err)
	}
	got, err := releaseCommand(env, []string{"node", "lanyi233/node-android-build", "arm64", "24"})
	if err != nil || got != "https://github.com/x/releases/download/t/node-android-arm64-24.10.1.tar.xz" {
		t.Fatalf("node = %q %v", got, err)
	}
	_, err = releaseCommand(env, []string{"node", "lanyi233/node-android-build", "x64", "24"})
	expectError(t, err, "无法获取 node 版本列表")
	_, err = releaseCommand(env, []string{"node", "bad repo", "arm64", "24"})
	expectError(t, err, "仓库名无效")
	_, err = releaseCommand(env, []string{"node", "a/b", "arm64", "24; rm"})
	expectError(t, err, "参数无效")
}
