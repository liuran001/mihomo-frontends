package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type fixture struct {
	t      *testing.T
	dir    string
	server *Server
}

func newFixture(t *testing.T, config Config, password string) *fixture {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"webroot", "scripts", "data"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("webroot/index.html", "<html>app</html>")
	write("secret.txt", "outside")
	write("scripts/host.sh", "printf '%s|' \"$@\"; printf 'secret=%s' \"$MIHOMO_SECRET\"; echo err >&2; exit 3\n")
	write("data/config.yaml", "mixed-port: 7890\nexternal-controller: 0.0.0.0:9090\n")
	if password != "" {
		hash, err := hashPassword(password)
		if err != nil {
			t.Fatal(err)
		}
		config.Password = hash
	}
	configPath := filepath.Join(dir, "data", "webui.json")
	if err := saveConfig(configPath, config); err != nil {
		t.Fatal(err)
	}
	server, err := newServer(configPath, filepath.Join(dir, "webroot"), filepath.Join(dir, "scripts"), filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	server.shell = "sh"
	return &fixture{t: t, dir: dir, server: server}
}

func (f *fixture) do(who caller, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	request = request.WithContext(context.WithValue(request.Context(), contextKey{}, who))
	recorder := httptest.NewRecorder()
	handler := f.server.Handler()
	if who.origin == originTailscale {
		handler = tailscaleIdentity(handler)
	}
	handler.ServeHTTP(recorder, request)
	return recorder
}

var apiHeaders = map[string]string{"Content-Type": "application/json", "X-Mihomo-Request": "1"}

func lan(addr string) caller {
	return caller{origin: originLAN, addr: netip.MustParseAddr(addr)}
}

func local() caller { return caller{origin: originLocal, addr: netip.MustParseAddr("127.0.0.1")} }

func (f *fixture) login(who caller, password string) *http.Cookie {
	f.t.Helper()
	response := f.do(who, "POST", "/api/login", `{"password":"`+password+`"}`, apiHeaders)
	if response.Code != http.StatusOK {
		f.t.Fatalf("login: %d %s", response.Code, response.Body.String())
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == sessionCookie {
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
				f.t.Fatalf("cookie flags: %+v", cookie)
			}
			return cookie
		}
	}
	f.t.Fatal("no session cookie")
	return nil
}

func withCookie(cookie *http.Cookie) map[string]string {
	headers := map[string]string{"Cookie": cookie.Name + "=" + cookie.Value}
	for name, value := range apiHeaders {
		headers[name] = value
	}
	return headers
}

func TestOriginRules(t *testing.T) {
	config := defaultConfig()
	config.LAN = true
	config.AllowCIDRs = []string{"192.168.1.0/24"}
	f := newFixture(t, config, "secret-pass")
	if code := f.do(lan("192.168.2.9"), "GET", "/", "", nil).Code; code != http.StatusForbidden {
		t.Fatalf("outside allowed CIDR: %d", code)
	}
	if code := f.do(lan("192.168.1.9"), "GET", "/", "", nil).Code; code != http.StatusSeeOther {
		t.Fatalf("allowed LAN without session should redirect to login: %d", code)
	}
	if code := f.do(caller{origin: originTailscale}, "GET", "/", "", nil).Code; code != http.StatusForbidden {
		t.Fatalf("tailscale disabled: %d", code)
	}

	config.LAN = false
	f = newFixture(t, config, "secret-pass")
	if code := f.do(lan("192.168.1.9"), "GET", "/", "", nil).Code; code != http.StatusForbidden {
		t.Fatalf("LAN disabled: %d", code)
	}

	empty := defaultConfig()
	empty.LAN = true
	if !empty.lanAllowed(netip.MustParseAddr("10.1.2.3")) || empty.lanAllowed(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("empty allow list must mean private ranges only")
	}
}

func TestPasswordSessionAndLockout(t *testing.T) {
	config := defaultConfig()
	config.LAN = true
	f := newFixture(t, config, "secret-pass")
	who := lan("192.168.1.9")
	if code := f.do(who, "POST", "/api/run", `{"script":"host.sh"}`, apiHeaders).Code; code != http.StatusUnauthorized {
		t.Fatalf("run without session: %d", code)
	}
	if code := f.do(who, "POST", "/api/login", `{"password":"x"}`, map[string]string{"Content-Type": "application/json"}).Code; code != http.StatusForbidden {
		t.Fatalf("login without CSRF header: %d", code)
	}
	cookie := f.login(who, "secret-pass")
	if response := f.do(who, "GET", "/", "", withCookie(cookie)); response.Code != http.StatusOK || response.Body.String() != "<html>app</html>" {
		t.Fatalf("index with session: %d %q", response.Code, response.Body.String())
	}

	other := lan("192.168.1.10")
	for range failureLimit {
		if code := f.do(other, "POST", "/api/login", `{"password":"wrong"}`, apiHeaders).Code; code != http.StatusUnauthorized {
			t.Fatalf("wrong password: %d", code)
		}
	}
	if code := f.do(other, "POST", "/api/login", `{"password":"secret-pass"}`, apiHeaders).Code; code != http.StatusTooManyRequests {
		t.Fatalf("lockout: %d", code)
	}

	// 改密码后旧会话失效
	if err := setPassword(f.server.configPath, base64.StdEncoding.EncodeToString([]byte("another-pass"))); err != nil {
		t.Fatal(err)
	}
	bumpTime(t, f.server.configPath)
	if code := f.do(who, "GET", "/api/session", "", withCookie(cookie)).Code; code != http.StatusUnauthorized {
		t.Fatalf("session after password change: %d", code)
	}
}

func TestPasswordlessRules(t *testing.T) {
	config := defaultConfig()
	config.LAN = true
	config.RequirePassword = false
	config.Tailscale = true
	config.TailscaleNoPassword = true
	config.TailscaleUsers = []string{"alice@example.com"}
	f := newFixture(t, config, "")
	if code := f.do(lan("192.168.1.9"), "GET", "/", "", nil).Code; code != http.StatusOK {
		t.Fatalf("LAN passwordless: %d", code)
	}
	if code := f.do(local(), "GET", "/", "", nil).Code; code != http.StatusOK {
		t.Fatalf("loopback follows require_password: %d", code)
	}
	ts := caller{origin: originTailscale}
	if code := f.do(ts, "GET", "/", "", map[string]string{tailscaleLogin: "alice@example.com"}).Code; code != http.StatusOK {
		t.Fatalf("allowed tailnet user: %d", code)
	}
	if code := f.do(ts, "GET", "/", "", map[string]string{tailscaleLogin: "mallory@example.com"}).Code; code != http.StatusForbidden {
		t.Fatalf("other tailnet user: %d", code)
	}
	if code := f.do(ts, "GET", "/", "", nil).Code; code != http.StatusSeeOther {
		t.Fatalf("tailnet without identity needs password: %d", code)
	}
	if code := f.do(ts, "GET", "/", "", map[string]string{tailscaleLogin: "=?utf-8?q?alice@example.com?="}).Code; code != http.StatusOK {
		t.Fatalf("encoded login: %d", code)
	}
	if response := f.do(ts, "POST", "/api/login", `{"password":"x"}`, apiHeaders); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "尚未设置密码") {
		t.Fatalf("login without password set: %d %s", response.Code, response.Body.String())
	}
}

func TestRunAllowList(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a POSIX sh")
	}
	config := defaultConfig()
	config.LAN = true
	config.RequirePassword = false
	f := newFixture(t, config, "")
	who := lan("192.168.1.9")
	run := func(body string) (int, map[string]any) {
		response := f.do(who, "POST", "/api/run", body, apiHeaders)
		var out map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &out)
		return response.Code, out
	}
	code, out := run(`{"script":"host.sh","args":["a b","$(id)",";x"],"env":{"MIHOMO_SECRET":"s'1"},"timeout":5000}`)
	if code != http.StatusOK || out["stdout"] != "a b|$(id)|;x|secret=s'1" || out["stderr"] != "err\n" || out["errno"] != float64(3) {
		t.Fatalf("run: %d %v", code, out)
	}
	for _, body := range []string{
		`{"script":"../secret.txt"}`, `{"script":"common.sh"}`, `{"script":"host.sh","env":{"PATH":"/tmp"}}`,
		`{"script":"host.sh","extra":1}`,
	} {
		if code, out := run(body); code == http.StatusOK {
			t.Fatalf("accepted %s: %v", body, out)
		}
	}
	if code := f.do(who, "POST", "/api/run", `{"script":"host.sh"}`, map[string]string{"Content-Type": "application/json"}).Code; code != http.StatusForbidden {
		t.Fatalf("run without CSRF header: %d", code)
	}
	if code := f.do(who, "POST", "/api/run", `{"script":"host.sh"}`, map[string]string{"Content-Type": "application/json", "X-Mihomo-Request": "1", "Origin": "http://evil.example"}).Code; code != http.StatusForbidden {
		t.Fatalf("cross-origin run: %d", code)
	}
}

func TestStaticStaysInWebroot(t *testing.T) {
	config := defaultConfig()
	config.LAN = true
	config.RequirePassword = false
	f := newFixture(t, config, "")
	for _, target := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"} {
		if response := f.do(lan("192.168.1.9"), "GET", target, "", nil); strings.Contains(response.Body.String(), "outside") {
			t.Fatalf("%s escaped webroot", target)
		}
	}
}

func TestControllerAddress(t *testing.T) {
	f := newFixture(t, defaultConfig(), "")
	address, err := f.server.controllerAddress()
	if err != nil || address != "127.0.0.1:9090" {
		t.Fatalf("controller: %q %v", address, err)
	}
}

func TestSetConfigValidates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "webui.json")
	encode := func(value string) string { return base64.StdEncoding.EncodeToString([]byte(value)) }
	if err := setConfig(path, encode(`{"enabled":true,"lan":true,"allow_cidrs":["192.168.1.7","10.0.0.0/8"],"tailscale_users":["a@b"]}`)); err != nil {
		t.Fatal(err)
	}
	config, err := loadConfig(path)
	if err != nil || !config.Enabled || config.AllowCIDRs[0] != "192.168.1.7/32" || config.Port != defaultPort {
		t.Fatalf("config: %+v %v", config, err)
	}
	for _, bad := range []string{`{"port":0}`, `{"allow_cidrs":["nope"]}`, `{"password":{}}`, `{"tailscale_users":["a b"]}`} {
		if err := setConfig(path, encode(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if err := setPassword(path, encode("short")); err == nil {
		t.Fatal("short password accepted")
	}
	if err := setPassword(path, encode("long-enough")); err != nil {
		t.Fatal(err)
	}
	config, _ = loadConfig(path)
	if !config.Password.verify("long-enough") || config.Password.verify("long-enougH") {
		t.Fatal("password verify")
	}
	if out := publicConfig(config); out["has_password"] != true || out["password"] != nil {
		t.Fatalf("public config leaks: %v", out)
	}
}

// bumpTime 让 reload 察觉到文件变化（部分文件系统的 mtime 精度不足）。
func bumpTime(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	later := info.ModTime().Add(2e9)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
}

func TestStaticCompressionAndCaching(t *testing.T) {
	config := defaultConfig()
	config.RequirePassword = false
	f := newFixture(t, config, "")
	wasm := bytes.Repeat([]byte("wasm-module-bytes "), 4096)
	name := "0123456789abcdef0123.wasm"
	if err := os.WriteFile(filepath.Join(f.server.webroot, name), wasm, 0o644); err != nil {
		t.Fatal(err)
	}
	var compressed bytes.Buffer
	compressor := gzip.NewWriter(&compressed)
	if _, err := compressor.Write(wasm); err != nil {
		t.Fatal(err)
	}
	if err := compressor.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.server.webroot, name+".gz"), compressed.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	response := f.do(local(), "GET", "/"+name, "", map[string]string{"Accept-Encoding": "gzip, br"})
	if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip response: %d %q", response.Code, response.Header().Get("Content-Encoding"))
	}
	if !strings.Contains(response.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("hashed wasm should be immutable: %q", response.Header().Get("Cache-Control"))
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(plain, wasm) {
		t.Fatalf("decompressed body mismatch: %v", err)
	}
	if response.Body.Len() >= len(wasm)/4 {
		t.Fatalf("compressed body too large: %d", response.Body.Len())
	}
	index := f.do(local(), "GET", "/", "", nil)
	if index.Header().Get("Content-Encoding") != "" || index.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index without gzip: %q %q", index.Header().Get("Content-Encoding"), index.Header().Get("Cache-Control"))
	}
	for _, encoding := range []string{"gzip;q=0", "gzip;q=invalid", "notgzip", "br"} {
		response := f.do(local(), "GET", "/"+name, "", map[string]string{"Accept-Encoding": encoding})
		if response.Header().Get("Content-Encoding") != "" || !bytes.Equal(response.Body.Bytes(), wasm) {
			t.Fatalf("unexpected compression for %q", encoding)
		}
	}
	bumpTime(t, filepath.Join(f.server.webroot, name))
	response = f.do(local(), "GET", "/"+name, "", map[string]string{"Accept-Encoding": "gzip"})
	if response.Header().Get("Content-Encoding") != "" || !bytes.Equal(response.Body.Bytes(), wasm) {
		t.Fatal("stale precompressed asset must use the original file without runtime compression")
	}
}
