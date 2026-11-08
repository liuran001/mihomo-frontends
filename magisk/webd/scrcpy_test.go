package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestScrcpyDefaultsSettingsAndOnDemandState(t *testing.T) {
	fixture, cookie := enhancedFixture(t, false)
	config, err := loadConfig(fixture.server.configPath)
	if err != nil || config.Enhanced.ScrcpyMode != "builtin" || config.Enhanced.ScrcpyFPS != 24 || config.Enhanced.ScrcpyBitRate != 2000000 || config.Enhanced.ScrcpyMaxSize != 1280 {
		t.Fatalf("unsafe defaults: %+v %v", config.Enhanced, err)
	}
	response := fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", `{"enabled":true,"max_size":960,"fps":15,"bit_rate":1000000}`, withCookie(cookie))
	if response.Code != http.StatusOK {
		t.Fatalf("valid screen settings: %s", response.Body.String())
	}
	for _, body := range []string{`{}`, `{"mode":"unknown"}`, `{"mode":""}`, `{"port":0}`, `{"fps":0}`, `{"max_size":0}`, `{"bit_rate":0}`, `{"fps":61}`, `{"max_size":2000}`, `{"bit_rate":1000000000}`, `{"executable":"/bin/sh"}`} {
		response = fixture.do(local(), "POST", "/api/enhanced/scrcpy-set", body, withCookie(cookie))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted unsafe settings: %s", body)
		}
	}
	response = fixture.do(local(), "GET", "/api/enhanced/status", "", withCookie(cookie))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"running":false`) || !strings.Contains(response.Body.String(), `"installed":false`) {
		t.Fatalf("on-demand state: %s", response.Body.String())
	}
	if fixture.server.scrcpyActive != nil {
		t.Fatal("status/settings started a screen service")
	}
}

func TestScrcpyAssetsStayInsideEnhancedAuthentication(t *testing.T) {
	fixture, cookie := enhancedFixture(t, true)
	if err := setEnhancedConfig(fixture.server.configPath, encodedJSON(`{"scrcpy":true}`)); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/enhanced/scrcpy/", "/enhanced/scrcpy/screen.js", "/enhanced/scrcpy/screen.css", "/enhanced/scrcpy/jmuxer.min.js", "/enhanced/scrcpy/stream"} {
		if code := fixture.do(local(), "GET", path, "", nil).Code; code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated asset %s: %d", path, code)
		}
		if code := fixture.do(local(), "GET", path, "", withCookie(cookie)).Code; code != http.StatusForbidden {
			t.Fatalf("locked asset %s: %d", path, code)
		}
	}
	operation := unlockCookie(t, fixture, cookie)
	headers := bothCookies(cookie, operation)
	for _, path := range []string{"/enhanced/scrcpy/", "/enhanced/scrcpy/screen.js", "/enhanced/scrcpy/screen.css"} {
		response := fixture.do(local(), "GET", path, "", headers)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Header().Get("Content-Security-Policy"), "default-src 'none'") {
			t.Fatalf("screen asset response: %s %d", path, response.Code)
		}
	}
	headers["Origin"] = "http://evil.invalid"
	if response := fixture.do(local(), "GET", "/enhanced/scrcpy/", "", headers); response.Code != http.StatusForbidden {
		t.Fatal("cross-origin screen read accepted")
	}
	if response := fixture.do(local(), "GET", "/enhanced/scrcpy/scrcpy-server-v5.0.1.jar", "", bothCookies(cookie, operation)); response.Code != http.StatusNotFound {
		t.Fatal("screen backend binary exposed")
	}
}

func TestScrcpyReservationAndExplicitStop(t *testing.T) {
	fixture, cookie := enhancedFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	active, err := fixture.server.reserveScrcpy(ctx, cancel)
	if err != nil || active == nil {
		t.Fatal(err)
	}
	if _, err := fixture.server.reserveScrcpy(ctx, cancel); err == nil {
		t.Fatal("second encoder permitted")
	}
	if response := fixture.do(local(), "POST", "/api/enhanced/scrcpy-stop", `{}`, withCookie(cookie)); response.Code != http.StatusOK {
		t.Fatalf("stop rejected: %s", response.Body.String())
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("stop did not cancel the encoder")
	}
}

func TestBuiltinScrcpyFailureReleasesReservationAndReader(t *testing.T) {
	fixture, cookie := enhancedFixture(t, false)
	if err := setEnhancedConfig(fixture.server.configPath, encodedJSON(`{"scrcpy":true}`)); err != nil {
		t.Fatal(err)
	}
	frontend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fixture.server.Handler().ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), contextKey{}, local())))
	}))
	defer frontend.Close()
	for attempt := 0; attempt < 2; attempt++ {
		header := http.Header{"Cookie": {cookie.Name + "=" + cookie.Value}, "Origin": {frontend.URL}}
		stream, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(frontend.URL, "http")+"/enhanced/scrcpy/stream", header)
		if err != nil {
			t.Fatal(err)
		}
		_ = stream.SetReadDeadline(time.Now().Add(2 * time.Second))
		var result map[string]any
		if err := stream.ReadJSON(&result); err != nil || result["type"] != "error" || !strings.Contains(fmt.Sprint(result["error"]), "校验失败") {
			t.Fatalf("missing asset error: %v %v", result, err)
		}
		if _, _, err := stream.ReadMessage(); err == nil {
			t.Fatal("failed capture left the connection open")
		}
		_ = stream.Close()
		fixture.server.shutdownScrcpy()
		if running := fixture.server.scrcpyStatus()["running"]; running != false {
			t.Fatal("failed capture left a session reserved")
		}
	}
}

func TestScrcpyShutdownWaitsForChildCleanup(t *testing.T) {
	fixture, _ := enhancedFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	active, err := fixture.server.reserveScrcpy(ctx, cancel)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		<-ctx.Done()
		close(active.done)
	}()
	fixture.server.shutdownScrcpy()
	select {
	case <-active.done:
	default:
		t.Fatal("shutdown returned before child cleanup")
	}
}

func TestScrcpyControlProtocolAndBounds(t *testing.T) {
	touch, err := encodeScrcpyControl([]byte(`{"type":"touch","action":0,"x":99,"y":200}`), 640, 960)
	if err != nil || len(touch) != 32 || touch[0] != 2 || binary.BigEndian.Uint32(touch[10:14]) != 99 || binary.BigEndian.Uint16(touch[18:20]) != 640 || binary.BigEndian.Uint16(touch[22:24]) != 65535 {
		t.Fatalf("touch encoding: %x %v", touch, err)
	}
	key, err := encodeScrcpyControl([]byte(`{"type":"key","key":4}`), 640, 960)
	if err != nil || len(key) != 28 || key[1] != 0 || key[15] != 1 || binary.BigEndian.Uint32(key[16:20]) != 4 {
		t.Fatalf("key encoding: %x %v", key, err)
	}
	paste, err := encodeScrcpyControl([]byte(`{"type":"text","text":"测试文字"}`), 640, 960)
	if err != nil || paste[0] != 9 || paste[9] != 1 || string(paste[14:]) != "测试文字" || binary.BigEndian.Uint32(paste[10:14]) != 12 {
		t.Fatalf("paste encoding: %x %v", paste, err)
	}
	for _, body := range []string{`null`, `{"type":"shell","text":"id"}`, `{"type":"key","key":9999}`, `{"type":"touch","action":9}`, `{"type":"touch","x":640,"y":20}`, `{"type":"touch","x":-1}`, `{"type":"text","text":""}`, `{"type":"text","text":"\u0000"}`, `{"type":"rotate","unknown":1}`} {
		if _, err := encodeScrcpyControl([]byte(body), 640, 960); err == nil {
			t.Fatalf("unsafe control accepted: %s", body)
		}
	}
	if _, err := encodeScrcpyControl([]byte(`{"type":"touch","x":0,"y":0}`), 0, 0); err == nil {
		t.Fatal("touch accepted before screen size")
	}
}

func TestScrcpyArgumentsNeverEnableNetworkingOrIdleCapture(t *testing.T) {
	config := EnhancedConfig{}
	if err := config.validate(); err != nil {
		t.Fatal(err)
	}
	arguments := strings.Join(scrcpyArguments(123, config), " ")
	for _, required := range []string{"scid=0000007b", "tunnel_forward=false", "audio=false", "cleanup=false", "power_on=false", "stay_awake=false", "clipboard_autosync=false", "repeat-previous-frame-after:long=1000000", "max_size=1280", "max_fps=24", "video_bit_rate=2000000"} {
		if !strings.Contains(arguments, required) {
			t.Fatalf("missing safe argument %s", required)
		}
	}
	for _, forbidden := range []string{"adb", "node ", "tcp", "screen_off_timeout", "show_touches=true"} {
		if strings.Contains(arguments, forbidden) {
			t.Fatalf("unexpected device side effect %s", forbidden)
		}
	}
}

func TestScreenAssetDownloadChecksHashSizeCacheAndCancellation(t *testing.T) {
	content := "verified screen dependency"
	digest := sha256.Sum256([]byte(content))
	checksum := hex.EncodeToString(digest[:])
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		switch request.URL.Path {
		case "/bad":
			_, _ = io.WriteString(writer, "untrusted")
		case "/large":
			writer.Header().Set("Content-Length", fmt.Sprint(3<<20))
		case "/slow":
			<-request.Context().Done()
		default:
			_, _ = io.WriteString(writer, content)
		}
	}))
	defer upstream.Close()
	directory := t.TempDir()
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	asset := bundledAsset{"screen.jar", upstream.URL, checksum}
	if err := fetchBundledAsset(context.Background(), client, directory, asset); err != nil {
		t.Fatal(err)
	}
	if !assetMatches(filepath.Join(directory, asset.name), checksum) {
		t.Fatal("installed asset not verified")
	}
	if err := fetchBundledAsset(context.Background(), client, directory, asset); err != nil || requests != 1 {
		t.Fatal("valid cached asset re-downloaded")
	}
	for _, path := range []string{"/bad", "/large", "/slow"} {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		err := fetchBundledAsset(ctx, client, directory, bundledAsset{"reject.jar", upstream.URL + path, checksum})
		cancel()
		if err == nil {
			t.Fatalf("accepted download %s", path)
		}
		if _, err := os.Stat(filepath.Join(directory, "reject.jar")); !os.IsNotExist(err) {
			t.Fatal("invalid partial asset installed")
		}
	}
	files, _ := filepath.Glob(filepath.Join(directory, ".download-*"))
	if len(files) != 0 {
		t.Fatal("temporary downloads leaked")
	}
}
