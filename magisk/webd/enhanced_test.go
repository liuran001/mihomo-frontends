package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func encodedJSON(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func enhancedFixture(t *testing.T, independent bool) (*fixture, *http.Cookie) {
	t.Helper()
	config := defaultConfig()
	// 网页管理与增强功能都开着（两者已各自独立，这里测的是其它设备经网页管理使用增强功能）
	config.Enabled = true
	config.LAN, config.Tailscale, config.TailscaleNoPassword = true, true, true
	fixture := newFixture(t, config, "main-password")
	patch := `{"enabled":true}`
	if independent {
		patch = `{"enabled":true,"password":"operation-password"}`
	}
	if err := setEnhancedConfig(fixture.server.configPath, encodedJSON(patch)); err != nil {
		t.Fatal(err)
	}
	return fixture, fixture.login(local(), "main-password")
}

func unlockCookie(t *testing.T, fixture *fixture, mainCookie *http.Cookie) *http.Cookie {
	t.Helper()
	response := fixture.do(local(), "POST", "/api/enhanced/unlock", `{"password":"operation-password"}`, withCookie(mainCookie))
	if response.Code != http.StatusOK {
		t.Fatalf("unlock: %d %s", response.Code, response.Body.String())
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == enhancedCookie {
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 900 {
				t.Fatalf("unsafe operation cookie: %+v", cookie)
			}
			return cookie
		}
	}
	t.Fatal("operation cookie missing")
	return nil
}

func bothCookies(mainCookie, operationCookie *http.Cookie) map[string]string {
	headers := withCookie(mainCookie)
	headers["Cookie"] += "; " + operationCookie.Name + "=" + operationCookie.Value
	return headers
}

// 增强功能不再依赖网页管理与主密码：管理器里直接可用（免操作密码），其它设备仍须主密码登录
func TestEnhancedWorksInManagerWithoutWebUIOrPasswords(t *testing.T) {
	fixture := newFixture(t, defaultConfig(), "")
	if err := setEnhancedConfig(fixture.server.configPath, encodedJSON(`{"enabled":true,"password":"operation-password"}`)); err != nil {
		t.Fatal(err)
	}
	config, _ := loadConfig(fixture.server.configPath)
	if config.Enabled || !config.Enhanced.Enabled || !config.serviceNeeded() {
		t.Fatalf("enabling enhanced must not enable web management: %+v", config)
	}
	_ = fixture.server.reload()
	manager := caller{origin: originManager}
	response := fixture.do(manager, "GET", "/api/enhanced/status", "", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"unlocked":true`) {
		t.Fatalf("manager should be unlocked without operation password: %s", response.Body.String())
	}
	if code := fixture.do(manager, "POST", "/api/enhanced/lock", `{}`, apiHeaders).Code; code != http.StatusOK {
		t.Fatalf("manager action without token rejected: %d", code)
	}
	if code := fixture.do(local(), "POST", "/api/enhanced/lock", `{}`, apiHeaders).Code; code != http.StatusUnauthorized {
		t.Fatalf("TCP caller without main password reached enhanced: %d", code)
	}
	if err := setEnhancedConfig(fixture.server.configPath, encodedJSON(`{"scrcpy":true}`)); err == nil {
		t.Fatal("web scrcpy enabled while web management is off")
	}
}

func TestEnhancedRemoteAccessNeedsMainPassword(t *testing.T) {
	fixture := newFixture(t, defaultConfig(), "")
	for _, body := range []string{`{"enhanced":{"enabled":true}}`, `null`, `{} {}`} {
		if err := setConfig(fixture.server.configPath, encodedJSON(body)); err == nil {
			t.Fatalf("remote settings accepted %s", body)
		}
	}
	fixture, cookie := enhancedFixture(t, true)
	for _, command := range []string{"enhanced-set", "enhanced-request", "boot"} {
		body, _ := json.Marshal(map[string]any{"script": "webui.sh", "args": []string{command}})
		response := fixture.do(local(), "POST", "/api/run", string(body), withCookie(cookie))
		if response.Code != http.StatusForbidden {
			t.Fatalf("TCP localhost elevated %s: %d", command, response.Code)
		}
	}
	if err := setConfig(fixture.server.configPath, encodedJSON(`{"require_password":false}`)); err != nil {
		t.Fatal(err)
	}
	_ = fixture.server.reload()
	if code := fixture.do(local(), "GET", "/api/enhanced/status", "", withCookie(cookie)).Code; code != http.StatusOK {
		t.Fatalf("status: %d", code)
	}
	if code := fixture.do(local(), "POST", "/api/enhanced/lock", `{}`, withCookie(cookie)).Code; code != http.StatusUnauthorized {
		t.Fatalf("passwordless web access reached enhanced: %d", code)
	}
	if err := setPassword(fixture.server.configPath, ""); err != nil {
		t.Fatal(err)
	}
	config, _ := loadConfig(fixture.server.configPath)
	if !config.Enhanced.Enabled || config.Enhanced.Scrcpy {
		t.Fatal("password removal should keep enhanced for the manager but turn off web scrcpy")
	}
}

func TestEnhancedRequiresRealMainSessionAndIndependentPassword(t *testing.T) {
	fixture, mainCookie := enhancedFixture(t, true)
	response := fixture.do(caller{origin: originTailscale}, "POST", "/api/enhanced/terminal", `{"command":"echo not-run"}`, map[string]string{
		"Content-Type": "application/json", "X-Mihomo-Request": "1", tailscaleLogin: "member@example.invalid",
	})
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("tailnet passwordless bypass: %d %s", response.Code, response.Body.String())
	}
	response = fixture.do(local(), "POST", "/api/enhanced/terminal", `{"command":"echo not-run"}`, withCookie(mainCookie))
	if response.Code != http.StatusForbidden {
		t.Fatal("main session bypassed operation password")
	}
	operationCookie := unlockCookie(t, fixture, mainCookie)
	otherMain := fixture.login(local(), "main-password")
	response = fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":true}`, bothCookies(otherMain, operationCookie))
	if response.Code != http.StatusForbidden {
		t.Fatal("operation session transferred to another main session")
	}
	headers := bothCookies(mainCookie, operationCookie)
	headers["Origin"] = "https://evil.invalid"
	if code := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":true}`, headers).Code; code != http.StatusForbidden {
		t.Fatal("cross-origin enhanced action was accepted")
	}
	headers = bothCookies(mainCookie, operationCookie)
	for _, body := range []string{`null`, `[]`, `{} {}`, `{"unknown":true}`} {
		if code := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", body, headers).Code; code != http.StatusBadRequest {
			t.Fatalf("accepted non-object or unknown fields: %s (%d)", body, code)
		}
	}
	if code := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":true,"port":9099}`, headers).Code; code != http.StatusBadRequest {
		t.Fatal("accepted scrcpy self-proxy")
	}
	if code := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":true,"port":8080}`, headers).Code; code != http.StatusOK {
		t.Fatalf("authorized scrcpy settings rejected: %d", code)
	}
	fixture.do(local(), "POST", "/api/logout", `{}`, headers)
	if code := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":false}`, headers).Code; code != http.StatusUnauthorized {
		t.Fatal("main logout did not revoke enhanced session")
	}
}

func TestEnhancedTokenBoundToManagerAndRevokedBySettings(t *testing.T) {
	fixture, mainCookie := enhancedFixture(t, true)
	manager := caller{origin: originManager}
	response := fixture.do(manager, "POST", "/api/enhanced/unlock", `{"password":"operation-password"}`, apiHeaders)
	var data map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil || response.Code != http.StatusOK {
		t.Fatalf("manager unlock: %d %s", response.Code, response.Body.String())
	}
	token, _ := data["token"].(string)
	if len(token) != 64 || len(response.Result().Cookies()) != 0 {
		t.Fatal("manager token must be returned only in the manager response")
	}
	headers := withCookie(mainCookie)
	headers["Authorization"] = "Bearer " + token
	if code := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":true}`, headers).Code; code != http.StatusForbidden {
		t.Fatal("manager token elevated a TCP caller")
	}
	// 管理器里不再需要操作密码：不带 token 也能操作
	if code := fixture.do(manager, "POST", "/api/enhanced/scrcpy-set", `{"enabled":true}`, apiHeaders).Code; code != http.StatusOK {
		t.Fatal("manager transport should not need the operation password")
	}
}

func TestPasswordWorkAndConfigUpdatesAreBounded(t *testing.T) {
	fixture, mainCookie := enhancedFixture(t, false)
	fixture.server.passwordSlots <- struct{}{}
	fixture.server.passwordSlots <- struct{}{}
	started := time.Now()
	response := fixture.do(local(), "POST", "/api/login", `{"password":"main-password"}`, apiHeaders)
	if response.Code != http.StatusTooManyRequests || time.Since(started) > time.Second {
		t.Fatal("password work did not fail fast when busy")
	}
	<-fixture.server.passwordSlots
	<-fixture.server.passwordSlots
	var group sync.WaitGroup
	for _, patch := range []string{`{"session_hours":22}`, `{"tailscale":true}`, `{"allow_cidrs":["192.168.4.0/24"]}`} {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := setConfig(fixture.server.configPath, encodedJSON(patch)); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	config, err := loadConfig(fixture.server.configPath)
	if err != nil || config.SessionHours != 22 || !config.Tailscale || len(config.AllowCIDRs) != 1 {
		t.Fatal("concurrent configuration edits overwrote each other")
	}
	response = fixture.do(local(), "GET", "/api/enhanced/status", "", withCookie(mainCookie))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"unlocked":true`) {
		t.Fatal("main-password-only enhanced session unavailable")
	}
	info, _ := os.Stat(filepath.Join(fixture.dir, "data", "webui.json"))
	if info.Mode().Perm() != 0o600 {
		t.Fatal("security settings are not private")
	}
	for _, invalid := range []*Hash{{Salt: "bad", Key: "bad", Iterations: 1000}, {Iterations: 2147483647}, {Iterations: 1000, Salt: strings.Repeat("x", 1<<16)}} {
		if invalid.valid() || invalid.verify("test") {
			t.Fatal("invalid/unbounded password hash accepted")
		}
	}
}

func TestPublicAccessWarningRecognizesTrustedNetworks(t *testing.T) {
	for _, item := range []struct {
		cidrs  []string
		public bool
	}{{nil, false}, {[]string{"192.168.0.0/16", "100.64.0.0/10", "fc00::/7"}, false}, {[]string{"0.0.0.0/0"}, true}, {[]string{"::/0"}, true}, {[]string{"203.0.113.10/32"}, true}} {
		config := defaultConfig()
		config.LAN, config.AllowCIDRs = true, item.cidrs
		if config.publicAccess() != item.public {
			t.Fatalf("public warning incorrect for %v", item.cidrs)
		}
	}
}
