package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

type changingReader struct {
	io.Reader
	once   sync.Once
	change func()
}

func (reader *changingReader) Read(buffer []byte) (int, error) {
	reader.once.Do(reader.change)
	return reader.Reader.Read(buffer)
}

func TestPasswordChangeWhileAuthenticatingDoesNotCreateSession(t *testing.T) {
	fixture := newFixture(t, defaultConfig(), "original-pass")
	request := httptest.NewRequest(http.MethodPost, "/api/login", &changingReader{
		Reader: strings.NewReader(`{"password":"original-pass"}`),
		change: func() {
			if err := setPassword(fixture.server.configPath, base64.StdEncoding.EncodeToString([]byte("updated-pass"))); err != nil {
				t.Fatal(err)
			}
			bumpTime(t, fixture.server.configPath)
		},
	})
	for name, value := range apiHeaders {
		request.Header.Set(name, value)
	}
	request = request.WithContext(context.WithValue(request.Context(), contextKey{}, local()))
	response := httptest.NewRecorder()
	fixture.server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict || len(response.Result().Cookies()) != 0 || len(fixture.server.sessions) != 0 {
		t.Fatalf("stale password created a session: %d %s", response.Code, response.Body.String())
	}
	fixture.login(local(), "updated-pass")
}

func TestConfigFailureClosesAccessAndRecovers(t *testing.T) {
	fixture, parent := enhancedFixture(t, false)
	for _, invalid := range []string{"{", "null"} {
		if err := os.WriteFile(fixture.server.configPath, []byte(invalid), 0o600); err != nil {
			t.Fatal(err)
		}
		bumpTime(t, fixture.server.configPath)
		for _, endpoint := range []string{"/", "/api/session", "/api/enhanced/status", "/enhanced/scrcpy/"} {
			response := fixture.do(local(), http.MethodGet, endpoint, "", withCookie(parent))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("invalid config %s allowed %s: %d", invalid, endpoint, response.Code)
			}
		}
		if err := saveConfig(fixture.server.configPath, fixture.server.config); err != nil {
			t.Fatal(err)
		}
		bumpTime(t, fixture.server.configPath)
		if response := fixture.do(local(), http.MethodGet, "/api/session", "", withCookie(parent)); response.Code != http.StatusUnauthorized {
			t.Fatalf("recovered config must not revive revoked sessions: %d", response.Code)
		}
	}
	if err := os.Remove(fixture.server.configPath); err != nil {
		t.Fatal(err)
	}
	if response := fixture.do(local(), http.MethodGet, "/", "", nil); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("removed config must not enable passwordless access: %d", response.Code)
	}
}

func TestRunConcurrencyIsBounded(t *testing.T) {
	fixture := newFixture(t, defaultConfig(), "")
	for range cap(fixture.server.runSlots) {
		fixture.server.runSlots <- struct{}{}
	}
	response := fixture.do(local(), http.MethodPost, "/api/run", `{"script":"host.sh"}`, apiHeaders)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("expected script concurrency rejection: %d %s", response.Code, response.Body.String())
	}
	for range cap(fixture.server.runSlots) {
		<-fixture.server.runSlots
	}
	response = fixture.do(local(), http.MethodPost, "/api/run", `{"script":"host.sh"} {}`, apiHeaders)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("multiple request objects accepted: %d", response.Code)
	}
}
