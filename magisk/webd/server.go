package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "embed"
)

//go:embed login.html
var loginPage []byte

// scripts 是网页可以调用的模块脚本；每个脚本自己校验子命令与参数。
var scripts = []string{"apply.sh", "backup.sh", "core.sh", "discovery.sh", "host.sh", "mihomo.sh", "module-update.sh", "onboarding.sh", "policy.sh", "substore.sh", "tailscale.sh", "webui.sh"}

var envNames = []string{"MIHOMO_SECRET"}

const (
	sessionCookie  = "mihomo_session"
	maxRunBody     = 1 << 20
	maxOutput      = 16 << 20
	maxRunTimeout  = 25 * time.Minute
	failureWindow  = 5 * time.Minute
	failureLimit   = 5
	lockoutPeriod  = time.Minute
	tailscaleLogin = "Tailscale-User-Login"
)

type origin int

const (
	originLocal origin = iota
	originLAN
	originTailscale
	originManager
)

func (o origin) String() string {
	switch o {
	case originLAN:
		return "lan"
	case originTailscale:
		return "tailscale"
	default:
		return "local"
	}
}

type contextKey struct{}

type caller struct {
	origin origin
	addr   netip.Addr
	login  string // Tailnet 登录名（仅 originTailscale）
}

type session struct {
	expires time.Time
	login   string
}

type failures struct {
	count  int
	first  time.Time
	locked time.Time
}

type Server struct {
	configPath string
	webroot    string
	scriptDir  string
	shell      string
	dataDir    string

	mu               sync.Mutex
	config           Config
	configTime       time.Time
	configSize       int64
	configErr        error
	sessions         map[string]session
	failures         map[string]*failures
	passwordID       string
	enhancedID       string
	enhancedSessions map[string]enhancedSession
	deviceSlots      chan struct{}
	terminalSlots    chan struct{}
	scrcpySlots      chan struct{}
	passwordSlots    chan struct{}
	runSlots         chan struct{}
	runWait          time.Duration
	controllerMu     sync.Mutex
	controllerCache  controllerSettings
	controllerTime   time.Time
	controllerSize   int64
	scrcpyMu         sync.Mutex
	scrcpyActive     *scrcpySession
	scrcpyError      string
}

func newServer(configPath, webroot, scriptDir, dataDir string) (*Server, error) {
	server := &Server{
		configPath: configPath, webroot: webroot, scriptDir: scriptDir, dataDir: dataDir,
		shell: "/system/bin/sh", sessions: map[string]session{}, failures: map[string]*failures{},
		enhancedSessions: map[string]enhancedSession{}, deviceSlots: make(chan struct{}, 2),
		terminalSlots: make(chan struct{}, 1), scrcpySlots: make(chan struct{}, 8), passwordSlots: make(chan struct{}, 2),
		runSlots: make(chan struct{}, 4), runWait: 20 * time.Second,
	}
	// 旧版把热点名称和密码另存在 webui-hotspot.json；现在直接读写系统热点配置，旧文件不再需要
	_ = os.Remove(filepath.Join(dataDir, "webui-hotspot.json"))
	if _, err := os.Stat(server.shell); err != nil {
		server.shell = "sh"
	}
	if err := server.reload(); err != nil {
		return nil, err
	}
	return server, nil
}

// reload 在 webui.json 变化时重新读取；密码变化后所有会话失效。
func (s *Server) reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(s.configPath)
	var modified time.Time
	var size int64
	if err == nil {
		modified = info.ModTime()
		size = info.Size()
	}
	if !s.configTime.IsZero() && modified.Equal(s.configTime) && size == s.configSize {
		return s.configErr
	}
	config, err := loadConfig(s.configPath)
	if err == nil && modified.IsZero() && !s.configTime.IsZero() {
		err = errors.New("网页管理配置已移除")
	}
	if err != nil {
		if s.configErr == nil || s.configErr.Error() != err.Error() {
			log.Printf("reload config: %v", err)
		}
		s.configErr = err
		if !modified.IsZero() {
			s.configTime, s.configSize = modified, size
		}
		s.sessions = map[string]session{}
		s.enhancedSessions = map[string]enhancedSession{}
		return err
	}
	passwordID := passwordConfigID(config)
	if passwordID != s.passwordID {
		s.sessions = map[string]session{}
	}
	if identity := enhancedConfigID(config); identity != s.enhancedID {
		s.enhancedSessions = map[string]enhancedSession{}
		s.enhancedID = identity
	}
	s.config, s.configTime, s.configSize, s.passwordID, s.configErr = config, modified, size, passwordID, nil
	return nil
}

func (s *Server) currentConfig() Config {
	if err := s.reload(); err != nil {
		return Config{RequirePassword: true, Password: &Hash{}}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.config
}

// Handler 包装所有路由：先按来源判定是否允许访问，再按会话判定是否已登录。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /login", s.handleLoginPage)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.authed(s.handleLogout))
	mux.HandleFunc("GET /api/session", s.authed(s.handleSession))
	mux.HandleFunc("POST /api/run", s.authed(s.handleRun))
	mux.HandleFunc("/clash/", s.authed(s.handleController))
	mux.HandleFunc("/api/enhanced/", s.authed(s.handleEnhanced))
	mux.HandleFunc("/enhanced/scrcpy/", s.authed(s.handleScrcpy))
	mux.HandleFunc("/", s.authed(s.handleStatic))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		who, ok := request.Context().Value(contextKey{}).(caller)
		if !ok {
			http.Error(writer, "forbidden", http.StatusForbidden)
			return
		}
		if err := s.reload(); err != nil {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"error": "安全配置不可用，请在本机修复网页管理设置"})
			return
		}
		config := s.currentConfig()
		if !s.originAllowed(config, who) {
			http.Error(writer, "来源不在允许范围内", http.StatusForbidden)
			return
		}
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Frame-Options", "SAMEORIGIN")
		mux.ServeHTTP(writer, request)
	})
}

func (s *Server) originAllowed(config Config, who caller) bool {
	switch who.origin {
	case originTailscale:
		return config.Tailscale && (who.login == "" || config.tailscaleUserAllowed(who.login))
	case originLAN:
		return config.LAN && config.lanAllowed(who.addr)
	default:
		return true
	}
}

// passwordless 判定无需登录即可使用：Tailnet 身份免密；本机与局域网在 require_password 关闭或没有密码时免密。
func (s *Server) passwordless(config Config, who caller) bool {
	switch who.origin {
	case originManager:
		return true
	case originTailscale:
		return config.TailscaleNoPassword && who.login != "" && config.tailscaleUserAllowed(who.login)
	default:
		return !config.RequirePassword || config.Password == nil
	}
}

func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		who := request.Context().Value(contextKey{}).(caller)
		config := s.currentConfig()
		if !s.passwordless(config, who) && !s.validSession(request) {
			if strings.HasPrefix(request.URL.Path, "/api/") || strings.HasPrefix(request.URL.Path, "/clash/") || strings.HasPrefix(request.URL.Path, "/enhanced/") {
				writeJSON(writer, http.StatusUnauthorized, map[string]any{"error": "需要登录"})
				return
			}
			target := "login"
			if request.URL.Path != "/" {
				target += "?next=" + url.QueryEscape(request.URL.RequestURI())
			}
			http.Redirect(writer, request, "/"+target, http.StatusSeeOther)
			return
		}
		next(writer, request)
	}
}

func (s *Server) validSession(request *http.Request) bool {
	cookie, err := request.Cookie(sessionCookie)
	if err != nil || len(cookie.Value) != 64 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.configErr != nil {
		return false
	}
	entry, ok := s.sessions[cookie.Value]
	if !ok {
		return false
	}
	if time.Now().After(entry.expires) {
		delete(s.sessions, cookie.Value)
		return false
	}
	return true
}

// sameOrigin 防跨站请求：写操作必须带自定义头（跨站表单无法设置），有 Origin 时须与 Host 一致。
func sameOrigin(request *http.Request) bool {
	if request.Header.Get("X-Mihomo-Request") != "1" {
		return false
	}
	if value := request.Header.Get("Origin"); value != "" {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host != request.Host {
			return false
		}
	}
	return true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func (s *Server) handleLoginPage(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'")
	_, _ = writer.Write(loginPage)
}

func (s *Server) handleLogin(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "请求来源无效"})
		return
	}
	who := request.Context().Value(contextKey{}).(caller)
	config := s.currentConfig()
	if s.passwordless(config, who) && config.Password == nil {
		writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
		return
	}
	if config.Password == nil {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "尚未设置密码，请在手机上的模块网页里设置"})
		return
	}
	key := who.addr.String() + "|" + who.login
	if wait := s.lockedFor(key); wait > 0 {
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "尝试次数过多，请 " + strconv.Itoa(int(wait.Seconds())+1) + " 秒后再试"})
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeStrict(io.LimitReader(request.Body, 4096), &body); err != nil || len(body.Password) > 256 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "请求无效"})
		return
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "密码验证繁忙，请稍后重试"})
		return
	}
	if !config.Password.verify(body.Password) {
		s.recordFailure(key)
		writeJSON(writer, http.StatusUnauthorized, map[string]any{"error": "密码错误"})
		return
	}
	s.clearFailures(key)
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": "无法创建会话"})
		return
	}
	value := hex.EncodeToString(token)
	lifetime := time.Duration(config.SessionHours) * time.Hour
	_ = s.reload()
	s.mu.Lock()
	if s.configErr != nil || passwordConfigID(config) != s.passwordID {
		s.mu.Unlock()
		writeJSON(writer, http.StatusConflict, map[string]any{"error": "安全设置已更改，请重新登录"})
		return
	}
	now := time.Now()
	for id, entry := range s.sessions {
		if now.After(entry.expires) {
			delete(s.sessions, id)
		}
	}
	if len(s.sessions) >= 128 {
		s.mu.Unlock()
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "登录会话过多，请先退出闲置会话"})
		return
	}
	s.sessions[value] = session{expires: now.Add(lifetime), login: who.login}
	s.mu.Unlock()
	http.SetCookie(writer, &http.Cookie{
		Name: sessionCookie, Value: value, Path: "/", MaxAge: int(lifetime.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: request.TLS != nil,
	})
	writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) lockedFor(key string) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.failures[key]
	if entry == nil {
		return 0
	}
	return time.Until(entry.locked)
}

func (s *Server) recordFailure(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if len(s.failures) > 1024 {
		s.failures = map[string]*failures{}
	}
	entry := s.failures[key]
	if entry == nil || now.Sub(entry.first) > failureWindow {
		entry = &failures{first: now}
		s.failures[key] = entry
	}
	entry.count++
	if entry.count >= failureLimit {
		entry.locked = now.Add(lockoutPeriod)
		entry.count = 0
		entry.first = now
	}
}

func (s *Server) clearFailures(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.failures, key)
}

func (s *Server) handleLogout(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "请求来源无效"})
		return
	}
	if cookie, err := request.Cookie(sessionCookie); err == nil {
		s.mu.Lock()
		delete(s.sessions, cookie.Value)
		for token, session := range s.enhancedSessions {
			if session.parent == cookie.Value {
				delete(s.enhancedSessions, token)
			}
		}
		s.mu.Unlock()
	}
	http.SetCookie(writer, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleSession(writer http.ResponseWriter, request *http.Request) {
	who := request.Context().Value(contextKey{}).(caller)
	config := s.currentConfig()
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok": true, "via": who.origin.String(), "login": who.login, "passwordless": s.passwordless(config, who),
	})
}

type runRequest struct {
	Script  string            `json:"script"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Timeout int               `json:"timeout"`
}

type cappedBuffer struct {
	bytes.Buffer
	truncated bool
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	if room := maxOutput - b.Len(); room < len(data) {
		if room > 0 {
			b.Buffer.Write(data[:room])
		}
		b.truncated = true
		return len(data), nil
	}
	return b.Buffer.Write(data)
}

// handleRun 只运行 scripts 中的模块脚本：不经过 shell 解析参数，环境变量只放行 envNames。
func (s *Server) handleRun(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) || !strings.HasPrefix(request.Header.Get("Content-Type"), "application/json") {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "请求来源无效"})
		return
	}
	var body runRequest
	if err := decodeStrict(http.MaxBytesReader(writer, request.Body, maxRunBody), &body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "请求无效：" + err.Error()})
		return
	}
	if !slices.Contains(scripts, body.Script) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "不允许的脚本：" + body.Script})
		return
	}
	if body.Script == "webui.sh" && (len(body.Args) == 0 || !slices.Contains([]string{"status", "set", "passwd", "start", "stop", "restart"}, body.Args[0])) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "增强功能设置只能在本机模块 WebUI 修改"})
		return
	}
	if len(body.Args) > 32 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "参数过多"})
		return
	}
	for _, arg := range body.Args {
		if strings.IndexByte(arg, 0) >= 0 {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "参数不能含 NUL"})
			return
		}
	}
	env := os.Environ()
	for name, value := range body.Env {
		if !slices.Contains(envNames, name) || strings.IndexByte(value, 0) >= 0 {
			writeJSON(writer, http.StatusForbidden, map[string]any{"error": "不允许的环境变量：" + name})
			return
		}
		env = append(env, name+"="+value)
	}
	// 页面打开时会并发读多项状态，超过并发上限的请求排队等空位，而不是立即 429（那样页面会一直读不出来）
	wait := time.NewTimer(s.runWait)
	select {
	case s.runSlots <- struct{}{}:
		wait.Stop()
		defer func() { <-s.runSlots }()
	case <-request.Context().Done():
		wait.Stop()
		return
	case <-wait.C:
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"error": "模块操作繁忙，请稍后重试"})
		return
	}
	timeout := time.Duration(body.Timeout) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	timeout = min(timeout, maxRunTimeout)
	// 不跟随请求取消：命令已开始就让它跑完，和 ksu.exec 一致，避免半途中断写配置
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, s.shell, append([]string{filepath.Join(s.scriptDir, body.Script)}, body.Args...)...)
	setupProcess(command)
	command.Env = env
	command.Dir = "/"
	var stdout, stderr cappedBuffer
	command.Stdout, command.Stderr = &stdout, &stderr
	command.WaitDelay = 5 * time.Second
	err := command.Run()
	errno := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			errno = exitErr.ExitCode()
		} else {
			errno = -1
			stderr.WriteString(err.Error())
		}
		if ctx.Err() != nil {
			errno = -1
			stderr.WriteString("\n命令超时")
		}
	}
	if stdout.truncated {
		stderr.WriteString("\n输出过长已截断")
	}
	writeJSON(writer, http.StatusOK, map[string]any{"errno": errno, "stdout": stdout.String(), "stderr": stderr.String()})
}

// controllerAddress 读取 config.yaml 的 external-controller（与 backend.js detectController 相同的规则）。
func (s *Server) controllerAddress() (string, error) {
	config, err := s.controllerConfig()
	return config.address, err
}

func (s *Server) handleStatic(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := path.Clean("/" + request.URL.Path)
	if name == "/" {
		name = "/index.html"
	}
	file := filepath.Join(s.webroot, filepath.FromSlash(name))
	if !strings.HasPrefix(file, filepath.Clean(s.webroot)+string(filepath.Separator)) {
		http.NotFound(writer, request)
		return
	}
	info, err := os.Stat(file)
	if err != nil || info.IsDir() {
		http.NotFound(writer, request)
		return
	}
	if ext := filepath.Ext(file); ext == ".wasm" {
		writer.Header().Set("Content-Type", "application/wasm")
	} else if kind := mime.TypeByExtension(ext); kind != "" {
		writer.Header().Set("Content-Type", kind)
	}
	// 文件名带内容哈希的 wasm 长期缓存；其余文件每次按修改时间协商（未变化时返回 304）
	if strings.HasSuffix(name, ".wasm") && hashedAsset.MatchString(path.Base(name)) {
		writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		writer.Header().Set("Cache-Control", "no-cache")
	}
	if compressible(name) {
		writer.Header().Add("Vary", "Accept-Encoding")
		if acceptsGzip(request.Header.Get("Accept-Encoding")) {
			if compressed, err := os.Open(file + ".gz"); err == nil {
				defer compressed.Close()
				if compressedInfo, err := compressed.Stat(); err == nil && compressedInfo.Mode().IsRegular() && !compressedInfo.ModTime().Before(info.ModTime()) {
					writer.Header().Set("Content-Encoding", "gzip")
					http.ServeContent(writer, request, name, info.ModTime(), compressed)
					return
				}
			}
		}
	}
	http.ServeFile(writer, request, file)
}

var hashedAsset = regexp.MustCompile(`^[0-9a-f]{16,}\.wasm$`)

func compressible(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".wasm", ".js", ".mjs", ".css", ".html", ".json", ".svg", ".otf", ".ttf", ".map", ".txt":
		return true
	}
	return false
}

func acceptsGzip(value string) bool {
	for _, item := range strings.Split(value, ",") {
		parts := strings.Split(item, ";")
		if !strings.EqualFold(strings.TrimSpace(parts[0]), "gzip") {
			continue
		}
		quality := 1.0
		for _, option := range parts[1:] {
			if name, weight, found := strings.Cut(strings.TrimSpace(option), "="); found && strings.EqualFold(name, "q") {
				quality, _ = strconv.ParseFloat(weight, 64)
			}
		}
		return quality > 0 && quality <= 1
	}
	return false
}

// listen 打开 TCP 与 unix socket 监听，并把来源写进请求上下文。
// tcpAddress 是设置里的监听地址：局域网访问时监听所有地址，否则只监听本机
func tcpAddress(config Config) (string, string) {
	host := "127.0.0.1"
	if config.LAN {
		host = "::"
	}
	return host, strconv.Itoa(config.Port)
}

func listenTCP(config Config) (net.Listener, error) {
	host, port := tcpAddress(config)
	tcp, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil && host == "::" {
		tcp, err = net.Listen("tcp", net.JoinHostPort("0.0.0.0", port))
	}
	return tcp, err
}

// configPollInterval 是检查 webui.json 的间隔：端口、局域网监听变化时换地址，关闭网页管理时退出
var configPollInterval = time.Second

func (s *Server) listen(ctx context.Context, socketPath string) error {
	defer s.shutdownScrcpy()
	config := s.currentConfig()
	tcp, err := listenTCP(config)
	if err != nil {
		return err
	}
	handler := s.Handler()
	newTCPServer := func() *http.Server {
		return &http.Server{
			Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10,
			ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
				addr, _ := netip.ParseAddrPort(conn.RemoteAddr().String())
				who := caller{origin: originLAN, addr: addr.Addr().Unmap()}
				if who.addr.IsLoopback() {
					who.origin = originLocal
				}
				return context.WithValue(ctx, contextKey{}, who)
			},
		}
	}
	var servers []*http.Server
	var listeners []net.Listener
	managerPath := filepath.Join(s.dataDir, "run", "webui-manager.sock")
	if err := os.MkdirAll(filepath.Dir(managerPath), 0o700); err != nil {
		tcp.Close()
		return err
	}
	_ = os.Remove(managerPath)
	manager, err := net.Listen("unix", managerPath)
	if err != nil {
		tcp.Close()
		return err
	}
	if err := os.Chmod(managerPath, 0o600); err != nil {
		manager.Close()
		tcp.Close()
		return err
	}
	defer os.Remove(managerPath)
	listeners = append(listeners, manager)
	servers = append(servers, &http.Server{
		Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if !strings.HasPrefix(request.URL.Path, "/api/enhanced/") {
				http.NotFound(writer, request)
				return
			}
			handler.ServeHTTP(writer, request)
		}), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second,
		ConnContext: func(ctx context.Context, _ net.Conn) context.Context {
			return context.WithValue(ctx, contextKey{}, caller{origin: originManager})
		},
	})
	if socketPath != "" {
		_ = os.Remove(socketPath)
		unix, err := net.Listen("unix", socketPath)
		if err != nil {
			tcp.Close()
			manager.Close()
			return err
		}
		_ = os.Chmod(socketPath, 0o600)
		listeners = append(listeners, unix)
		servers = append(servers, &http.Server{
			Handler: tailscaleIdentity(handler), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10,
			ConnContext: func(ctx context.Context, _ net.Conn) context.Context {
				return context.WithValue(ctx, contextKey{}, caller{origin: originTailscale})
			},
		})
	}
	log.Printf("listening on %s (unix %q)", tcp.Addr(), socketPath)
	errs := make(chan error, len(servers)+1)
	for index, server := range servers {
		go func(server *http.Server, listener net.Listener) { errs <- server.Serve(listener) }(server, listeners[index])
	}
	// 局域网 / 本机的 TCP 服务单独管理：换端口时先在新地址监听，再关闭旧的（连同旧端口上的连接）
	var tcpMu sync.Mutex
	tcpServer := newTCPServer()
	serveTCP := func(server *http.Server, listener net.Listener) {
		go func() {
			err := server.Serve(listener)
			tcpMu.Lock()
			current := server == tcpServer
			tcpMu.Unlock()
			if current {
				errs <- err
			}
		}()
	}
	serveTCP(tcpServer, tcp)
	// 旧地址上正在处理的请求（例如保存设置的这次请求）先做完再关
	retire := func(server *http.Server) {
		go func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if server.Shutdown(shutdownCtx) != nil {
				server.Close()
			}
		}()
	}
	disabled := make(chan struct{})
	stopWatch := make(chan struct{})
	defer close(stopWatch)
	go func() {
		bound := config
		ticker := time.NewTicker(configPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stopWatch:
				return
			case <-ticker.C:
			}
			if s.reload() != nil {
				continue
			}
			s.mu.Lock()
			next := s.config
			s.mu.Unlock()
			if !next.Enabled {
				log.Printf("网页管理已关闭，退出")
				close(disabled)
				return
			}
			if next.Port == bound.Port && next.LAN == bound.LAN {
				continue
			}
			listener, err := listenTCP(next)
			if err != nil {
				host, port := tcpAddress(bound)
				log.Printf("改用新地址失败，继续使用 %s：%v", net.JoinHostPort(host, port), err)
				bound = next // 不反复重试同一个地址；设置再变时重新尝试
				continue
			}
			server := newTCPServer()
			tcpMu.Lock()
			old := tcpServer
			tcpServer = server
			tcpMu.Unlock()
			serveTCP(server, listener)
			retire(old)
			bound = next
			log.Printf("listening on %s", listener.Addr())
		}
	}()
	select {
	case <-ctx.Done():
	case <-disabled:
		err = nil
	case err = <-errs:
	}
	tcpMu.Lock()
	last := tcpServer
	tcpServer = nil
	tcpMu.Unlock()
	_ = last.Close()
	for _, server := range servers {
		_ = server.Close()
	}
	if socketPath != "" {
		_ = os.Remove(socketPath)
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// tailscaleIdentity 读取内核 tailscale serve 加上的身份头（只在 unix socket 上可信）。
func tailscaleIdentity(next http.Handler) http.Handler {
	decoder := new(mime.WordDecoder)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		who := request.Context().Value(contextKey{}).(caller)
		login := request.Header.Get(tailscaleLogin)
		if decoded, err := decoder.DecodeHeader(login); err == nil {
			login = decoded
		}
		who.login = strings.TrimSpace(login)
		if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
			if addr, err := netip.ParseAddr(strings.TrimSpace(strings.Split(forwarded, ",")[0])); err == nil {
				who.addr = addr
			}
		}
		next.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), contextKey{}, who)))
	})
}
