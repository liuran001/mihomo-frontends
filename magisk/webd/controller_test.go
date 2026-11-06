package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func setController(t *testing.T, fixture *fixture, address, secret string) {
	t.Helper()
	data := "external-controller: " + address + "\nsecret: " + strconv.Quote(secret) + "\n"
	if err := os.WriteFile(filepath.Join(fixture.server.dataDir, "config.yaml"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestControllerProxyAuthenticatesAndRewrites(t *testing.T) {
	received := make(chan *http.Request, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		received <- request.Clone(context.Background())
		writer.Header().Set("Set-Cookie", "upstream=private")
		if request.URL.Path == "/ui" {
			writer.Header().Set("Location", "/ui/")
			writer.WriteHeader(http.StatusMovedPermanently)
			return
		}
		_, _ = io.WriteString(writer, `{"ok":true}`)
	}))
	defer upstream.Close()
	fixture := newFixture(t, defaultConfig(), "main-password")
	setController(t, fixture, strings.TrimPrefix(upstream.URL, "http://"), "controller-secret")
	if code := fixture.do(local(), "GET", "/clash/proxies", "", nil).Code; code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated controller access: %d", code)
	}
	cookie := fixture.login(local(), "main-password")
	headers := withCookie(cookie)
	headers["Origin"] = "https://evil.invalid"
	if code := fixture.do(local(), "GET", "/clash/proxies", "", headers).Code; code != http.StatusForbidden {
		t.Fatal("cross-origin controller request accepted")
	}
	headers = withCookie(cookie)
	headers["Authorization"] = "Bearer caller-secret"
	headers[tailscaleLogin] = "forged@example.invalid"
	response := fixture.do(local(), "GET", "/clash/proxies/group%2Fchild?token=caller-secret&hello=world", "", headers)
	if response.Code != http.StatusOK {
		t.Fatalf("proxy failed: %d %s", response.Code, response.Body.String())
	}
	request := <-received
	if request.URL.EscapedPath() != "/proxies/group%2Fchild" || request.URL.Query().Get("token") != "" || request.URL.Query().Get("hello") != "world" {
		t.Fatalf("proxy path or query: %s", request.URL.String())
	}
	if request.Header.Get("Authorization") != "Bearer controller-secret" || request.Header.Get("Cookie") != "" || request.Header.Get(tailscaleLogin) != "" || request.Header.Get("Origin") != "" {
		t.Fatal("proxy did not replace controller credentials or leaked WebUI identity")
	}
	if response.Header().Get("Set-Cookie") != "" {
		t.Fatal("controller overwrote WebUI cookies")
	}
	response = fixture.do(local(), "GET", "/clash/ui", "", withCookie(cookie))
	if response.Code != http.StatusMovedPermanently || response.Header().Get("Location") != "/clash/ui/" {
		t.Fatalf("dashboard redirect escaped authenticated prefix: %d %s", response.Code, response.Header().Get("Location"))
	}
}

func TestControllerScalarIPv6AndUnsafeValues(t *testing.T) {
	for _, value := range []string{"[::1]:9090", "[::]:9090", "*:9090", "'a''b # c'", `"secret # value" # comment`} {
		if _, err := controllerScalar(value); err != nil {
			t.Fatalf("valid scalar %q: %v", value, err)
		}
	}
	for _, value := range []string{"[one, two]", "{url: unsafe}", "&anchor value", "*alias", "|", `"secret" garbage`} {
		if _, err := controllerScalar(value); err == nil {
			t.Fatalf("unsafe scalar %q accepted", value)
		}
	}
	for _, address := range []string{"[::1]:9090", "[::]:9090", "*:9090"} {
		fixture := newFixture(t, defaultConfig(), "")
		setController(t, fixture, address, "hash#secret")
		config, err := fixture.server.controllerConfig()
		if err != nil || config.secret != "hash#secret" {
			t.Fatalf("controller IPv6: %+v %v", config, err)
		}
		if address == "[::1]:9090" && config.address != address {
			t.Fatal("IPv6 loopback not preserved")
		}
	}
}

func testWebSocketRequest(t *testing.T, address, path, cookies string) (net.Conn, *bufio.Reader) {
	t.Helper()
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	_, err = fmt.Fprintf(connection, "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: %s\r\nOrigin: http://%s\r\n\r\n", path, address, cookies, address)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("websocket upgrade: %v %v", response, err)
	}
	return connection, reader
}

func TestScrcpyWebSocketClosesOnLockAndStripsIdentity(t *testing.T) {
	received := make(chan *http.Request, 1)
	closed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		received <- request.Clone(context.Background())
		connection, buffer, err := writer.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n")
		_ = buffer.Flush()
		_, _ = io.Copy(io.Discard, connection)
		close(closed)
	}))
	defer upstream.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	fixture, mainCookie := enhancedFixture(t, true)
	if err := setEnhancedConfig(fixture.server.configPath, encodedJSON(`{"scrcpy":true,"scrcpy_mode":"external","scrcpy_port":`+port+`}`)); err != nil {
		t.Fatal(err)
	}
	operationCookie := unlockCookie(t, fixture, mainCookie)
	frontend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fixture.server.Handler().ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), contextKey{}, local())))
	}))
	defer frontend.Close()
	connection, reader := testWebSocketRequest(t, strings.TrimPrefix(frontend.URL, "http://"), "/enhanced/scrcpy/socket", bothCookies(mainCookie, operationCookie)["Cookie"])
	request := <-received
	if request.URL.Path != "/enhanced/scrcpy/socket" || request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" {
		t.Fatal("scrcpy proxy leaked identity or broke base path")
	}
	response := fixture.do(local(), "POST", "/api/enhanced/lock", `{}`, bothCookies(mainCookie, operationCookie))
	if response.Code != http.StatusOK {
		t.Fatal("lock failed")
	}
	select {
	case <-closed:
	case <-time.After(7 * time.Second):
		t.Fatal("locking enhanced mode left screen WebSocket alive")
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("locked screen connection still readable")
	}
}

func TestControllerWebSocketAuthenticatesAndClosesOnLogout(t *testing.T) {
	received := make(chan *http.Request, 1)
	closed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		received <- request.Clone(context.Background())
		connection, buffer, err := writer.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n")
		_ = buffer.Flush()
		_, _ = io.Copy(io.Discard, connection)
		close(closed)
	}))
	defer upstream.Close()
	fixture := newFixture(t, defaultConfig(), "main-password")
	setController(t, fixture, strings.TrimPrefix(upstream.URL, "http://"), "controller-secret")
	if response := fixture.do(local(), http.MethodGet, "/clash/traffic", "", map[string]string{"Connection": "Upgrade", "Upgrade": "websocket"}); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated WebSocket: %d", response.Code)
	}
	cookie := fixture.login(local(), "main-password")
	frontend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fixture.server.Handler().ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), contextKey{}, local())))
	}))
	defer frontend.Close()
	connection, reader := testWebSocketRequest(t, strings.TrimPrefix(frontend.URL, "http://"), "/clash/traffic?token=untrusted&interval=1000", withCookie(cookie)["Cookie"])
	request := <-received
	if request.URL.Path != "/traffic" || request.URL.Query().Get("token") != "" || request.Header.Get("Authorization") != "Bearer controller-secret" || request.Header.Get("Cookie") != "" || request.Header.Get("Origin") != "" {
		t.Fatal("WebSocket proxy leaked identity or failed to apply controller credentials")
	}
	if response := fixture.do(local(), http.MethodPost, "/api/logout", `{}`, withCookie(cookie)); response.Code != http.StatusOK {
		t.Fatalf("logout failed: %d", response.Code)
	}
	select {
	case <-closed:
	case <-time.After(7 * time.Second):
		t.Fatal("logout left controller WebSocket alive")
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("logged-out controller WebSocket remained readable")
	}
}
