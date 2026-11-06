package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

const enhancedCookie = "mihomo_operation"
const enhancedLifetime = 15 * time.Minute

type enhancedSession struct {
	expires time.Time
	parent  string
	manager bool
}

func decodeStrict(reader io.Reader, value any) error {
	decoder := json.NewDecoder(reader)
	var data json.RawMessage
	if err := decoder.Decode(&data); err != nil {
		return fmt.Errorf("请求无效：%w", err)
	}
	if len(data) == 0 || data[0] != '{' || decoder.Decode(new(any)) != io.EOF {
		return errors.New("请求只能包含一个 JSON 对象")
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}

func (s *Server) enhancedAllowed(request *http.Request, config Config) bool {
	if !config.Enhanced.Enabled || config.Password == nil || !config.RequirePassword {
		return false
	}
	manager := request.Context().Value(contextKey{}).(caller).origin == originManager
	if !manager && !s.validSession(request) {
		return false
	}
	if config.Enhanced.Password == nil {
		return true
	}
	token := ""
	if manager {
		token = strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	} else if cookie, err := request.Cookie(enhancedCookie); err == nil {
		token = cookie.Value
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	session, found := s.enhancedSessions[token]
	if !found || session.manager != manager {
		return false
	}
	if !time.Now().Before(session.expires) {
		delete(s.enhancedSessions, token)
		return false
	}
	if manager {
		return true
	}
	parent, err := request.Cookie(sessionCookie)
	return err == nil && parent.Value == session.parent
}

func (s *Server) handleEnhanced(writer http.ResponseWriter, request *http.Request) {
	config := s.currentConfig()
	manager := request.Context().Value(contextKey{}).(caller).origin == originManager
	action := strings.TrimPrefix(request.URL.Path, "/api/enhanced/")
	if action == "status" && request.Method == http.MethodGet {
		status := config.Enhanced.public()
		status["ok"], status["unlocked"] = true, s.enhancedAllowed(request, config)
		status["requires_main"], status["can_configure"] = !manager && !s.validSession(request), manager
		status["public_access"] = config.publicAccess()
		if status["unlocked"] == true {
			status["screen_service"] = s.scrcpyStatus()
		}
		writeJSON(writer, http.StatusOK, status)
		return
	}
	if !config.Enhanced.Enabled || config.Password == nil || !config.RequirePassword {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "请先在本机模块 WebUI 中启用增强功能并设置主密码"})
		return
	}
	if !manager && !s.validSession(request) {
		writeJSON(writer, http.StatusUnauthorized, map[string]any{"error": "增强功能必须先使用主 WebUI 密码登录"})
		return
	}
	if request.Method != http.MethodPost || !sameOrigin(request) || !strings.HasPrefix(request.Header.Get("Content-Type"), "application/json") {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "请求来源或方法无效"})
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 32<<10)
	if action == "unlock" {
		s.unlockEnhanced(writer, request, config, manager)
		return
	}
	if !s.enhancedAllowed(request, config) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "增强功能已锁定，请输入操作密码", "locked": true})
		return
	}
	if action == "lock" {
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if cookie, err := request.Cookie(enhancedCookie); err == nil && !manager {
			token = cookie.Value
		}
		s.mu.Lock()
		delete(s.enhancedSessions, token)
		s.mu.Unlock()
		http.SetCookie(writer, &http.Cookie{Name: enhancedCookie, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
		return
	}
	slots := s.deviceSlots
	if action == "terminal" {
		slots = s.terminalSlots
	}
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "设备操作正在执行，请稍后重试"})
		return
	}
	var result map[string]any
	var err error
	switch action {
	case "battery":
		result, err = s.readBattery(request.Context())
	case "sms":
		var body struct {
			Limit int `json:"limit"`
		}
		err = decodeStrict(request.Body, &body)
		if err == nil {
			result, err = s.readMessages(request.Context(), body.Limit)
		}
	case "hotspot":
		result, err = s.readHotspot(request.Context())
	case "hotspot-set":
		var body hotspotRequest
		err = decodeStrict(request.Body, &body)
		if err == nil {
			result, err = s.setHotspot(request.Context(), body)
		}
	case "terminal":
		var body terminalRequest
		err = decodeStrict(request.Body, &body)
		if err == nil {
			result, err = s.runTerminal(request.Context(), body)
		}
	case "scrcpy-set":
		var body struct {
			Enabled *bool   `json:"enabled"`
			Port    *int    `json:"port"`
			Mode    *string `json:"mode"`
			MaxSize *int    `json:"max_size"`
			FPS     *int    `json:"fps"`
			BitRate *int    `json:"bit_rate"`
		}
		err = decodeStrict(request.Body, &body)
		if err == nil && body.Enabled == nil && body.Port == nil && body.Mode == nil && body.MaxSize == nil && body.FPS == nil && body.BitRate == nil {
			err = errors.New("缺少屏幕配置")
		}
		if err == nil && (body.MaxSize != nil && (*body.MaxSize < 640 || *body.MaxSize > 1920) ||
			body.FPS != nil && (*body.FPS < 5 || *body.FPS > 60) ||
			body.BitRate != nil && (*body.BitRate < 256000 || *body.BitRate > 8000000) ||
			body.Port != nil && (*body.Port < 1 || *body.Port > 65535) ||
			body.Mode != nil && *body.Mode != "builtin" && *body.Mode != "external") {
			err = errors.New("屏幕参数超出允许范围")
		}
		if err == nil {
			err = updateConfig(s.configPath, func(current *Config) error {
				if enhancedConfigID(*current) != enhancedConfigID(config) || !current.Enhanced.Enabled {
					return errors.New("安全设置已更改，请重新登录后操作")
				}
				if body.Enabled != nil {
					current.Enhanced.Scrcpy = *body.Enabled
				}
				if body.Port != nil {
					current.Enhanced.ScrcpyPort = *body.Port
				}
				if body.Mode != nil {
					current.Enhanced.ScrcpyMode = *body.Mode
				}
				if body.MaxSize != nil {
					current.Enhanced.ScrcpyMaxSize = *body.MaxSize
				}
				if body.FPS != nil {
					current.Enhanced.ScrcpyFPS = *body.FPS
				}
				if body.BitRate != nil {
					current.Enhanced.ScrcpyBitRate = *body.BitRate
				}
				if current.Enhanced.ScrcpyPort == current.Port {
					return errors.New("web scrcpy 不能指向 WebUI 自身的端口")
				}
				if err := current.validate(); err != nil {
					return err
				}
				result = current.Enhanced.public()
				return nil
			})
			if err == nil {
				s.stopScrcpy()
			}
		}
	case "scrcpy-stop":
		var body struct{}
		err = decodeStrict(request.Body, &body)
		if err == nil {
			s.stopScrcpy()
			result = map[string]any{"stopping": true}
		}
	default:
		writeJSON(writer, http.StatusNotFound, map[string]any{"error": "不存在的增强操作"})
		return
	}
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	result["ok"] = true
	writeJSON(writer, http.StatusOK, result)
}

func (s *Server) unlockEnhanced(writer http.ResponseWriter, request *http.Request, config Config, manager bool) {
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeStrict(request.Body, &body); err != nil || len(body.Password) > 256 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "操作密码无效"})
		return
	}
	who := request.Context().Value(contextKey{}).(caller)
	key := "enhanced|" + who.addr.String() + "|" + who.login
	if wait := s.lockedFor(key); wait > 0 {
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "密码尝试过多，请一分钟后再试"})
		return
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "密码验证繁忙，请稍后重试"})
		return
	}
	if config.Enhanced.Password != nil && !config.Enhanced.Password.verify(body.Password) {
		s.recordFailure(key)
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "操作密码错误", "locked": true})
		return
	}
	s.clearFailures(key)
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": "无法创建操作会话"})
		return
	}
	token := hex.EncodeToString(value)
	parent := ""
	if cookie, err := request.Cookie(sessionCookie); err == nil {
		parent = cookie.Value
	}
	_ = s.reload()
	s.mu.Lock()
	parentSession, found := s.sessions[parent]
	if s.configErr != nil || enhancedConfigID(config) != s.enhancedID || (!manager && (!found || !time.Now().Before(parentSession.expires))) {
		s.mu.Unlock()
		writeJSON(writer, http.StatusConflict, map[string]any{"error": "安全设置或主会话已更改，请重新登录"})
		return
	}
	for id, entry := range s.enhancedSessions {
		if !time.Now().Before(entry.expires) || (parent != "" && entry.parent == parent) {
			delete(s.enhancedSessions, id)
		}
	}
	if len(s.enhancedSessions) >= 128 {
		s.mu.Unlock()
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "操作会话过多，请稍后重试"})
		return
	}
	s.enhancedSessions[token] = enhancedSession{expires: time.Now().Add(enhancedLifetime), parent: parent, manager: manager}
	s.mu.Unlock()
	response := map[string]any{"ok": true, "unlocked": true, "expires_in": int(enhancedLifetime.Seconds())}
	if manager {
		response["token"] = token
	} else {
		http.SetCookie(writer, &http.Cookie{Name: enhancedCookie, Value: token, Path: "/", MaxAge: int(enhancedLifetime.Seconds()), HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: request.TLS != nil})
	}
	writeJSON(writer, http.StatusOK, response)
}

func localEnhancedRequest(dataDir, action, encoded string) (map[string]any, error) {
	if !map[string]bool{"status": true, "unlock": true, "lock": true, "battery": true, "sms": true, "hotspot": true, "hotspot-set": true, "terminal": true, "scrcpy-set": true, "scrcpy-stop": true}[action] {
		return nil, errors.New("不允许的增强操作")
	}
	data, err := decodeArg(encoded)
	if err != nil || len(data) > 32<<10 {
		return nil, errors.New("增强请求无效或过大")
	}
	var envelope struct {
		Token   string          `json:"token"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := decodeStrict(bytes.NewReader(data), &envelope); err != nil {
		return nil, err
	}
	if action == "status" {
		config, err := loadConfig(filepath.Join(dataDir, "webui.json"))
		if err != nil {
			return nil, err
		}
		if !config.Enabled || !config.Enhanced.Enabled {
			status := config.Enhanced.public()
			status["ok"], status["unlocked"], status["can_configure"], status["public_access"] = true, false, true, config.publicAccess()
			return status, nil
		}
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", filepath.Join(dataDir, "run", "webui-manager.sock"))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 70 * time.Second}
	method := http.MethodPost
	if action == "status" {
		method = http.MethodGet
	}
	request, err := http.NewRequest(method, "http://localhost/api/enhanced/"+action, bytes.NewReader(envelope.Payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mihomo-Request", "1")
	request.Header.Set("Authorization", "Bearer "+envelope.Token)
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("增强服务未连接，请先启用网页管理")
	}
	defer response.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		result["ok"] = false
	}
	return result, nil
}

func (s *Server) handleScrcpy(writer http.ResponseWriter, request *http.Request) {
	config := s.currentConfig()
	if !s.enhancedAllowed(request, config) || !config.Enhanced.Scrcpy {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "请先在 WebUI 解锁增强功能并开启 web scrcpy"})
		return
	}
	if !proxyOriginAllowed(request) || (request.Method != http.MethodGet && request.Method != http.MethodHead) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "仅允许同源屏幕请求"})
		return
	}
	if config.Enhanced.ScrcpyMode == "builtin" {
		s.handleBuiltinScrcpy(writer, request, config)
		return
	}
	if config.Enhanced.ScrcpyPort == config.Port {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "web scrcpy 端口不能等于网页管理端口"})
		return
	}
	select {
	case s.scrcpySlots <- struct{}{}:
		defer func() { <-s.scrcpySlots }()
	default:
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "屏幕连接过多，请关闭闲置面板"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), enhancedLifetime)
	defer cancel()
	if strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					current := s.currentConfig()
					who := request.Context().Value(contextKey{}).(caller)
					if !current.Enabled || !current.Enhanced.Scrcpy || current.Enhanced.ScrcpyMode != "external" || current.Enhanced.ScrcpyPort != config.Enhanced.ScrcpyPort || !s.originAllowed(current, who) || !s.enhancedAllowed(request, current) {
						cancel()
						return
					}
				}
			}
		}()
	}
	proxy := &httputil.ReverseProxy{
		Transport: localTransport,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.SetURL(&url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", config.Enhanced.ScrcpyPort)})
			stripPrivateHeaders(proxyRequest.Out.Header)
			proxyRequest.Out.Header.Del("Authorization")
		},
		ModifyResponse: func(response *http.Response) error {
			response.Header.Del("Set-Cookie")
			response.Header.Set("Cache-Control", "no-store")
			return nil
		},
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, _ error) {
			writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "web scrcpy 未运行，请在本机安装服务，绑定 127.0.0.1 并设置路径 /enhanced/scrcpy/"})
		},
	}
	proxy.ServeHTTP(writer, request.WithContext(ctx))
}
