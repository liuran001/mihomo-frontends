package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type controllerSettings struct {
	address string
	secret  string
}

var localTransport = &http.Transport{
	DialContext:  (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second,
	ResponseHeaderTimeout: 15 * time.Second,
}

func controllerScalar(value string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, `"`) {
		decoder := json.NewDecoder(strings.NewReader(value))
		var result string
		if err := decoder.Decode(&result); err != nil {
			return "", errors.New("控制器配置引号无效")
		}
		rest := strings.TrimSpace(value[decoder.InputOffset():])
		if rest != "" && !strings.HasPrefix(rest, "#") {
			return "", errors.New("控制器配置引号无效")
		}
		return result, nil
	}
	if strings.HasPrefix(value, "'") {
		var result strings.Builder
		for index := 1; index < len(value); index++ {
			if value[index] != '\'' {
				result.WriteByte(value[index])
				continue
			}
			if index+1 < len(value) && value[index+1] == '\'' {
				result.WriteByte('\'')
				index++
				continue
			}
			rest := strings.TrimSpace(value[index+1:])
			if rest == "" || strings.HasPrefix(rest, "#") {
				return result.String(), nil
			}
			break
		}
		return "", errors.New("控制器配置引号无效")
	}
	if index := strings.Index(value, " #"); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	if value == "~" || strings.EqualFold(value, "null") {
		return "", nil
	}
	_, ipPortErr := netip.ParseAddrPort(value)
	wildcardHost, wildcardPort, wildcardErr := net.SplitHostPort(value)
	_, wildcardPortErr := strconv.Atoi(wildcardPort)
	wildcard := wildcardErr == nil && wildcardHost == "*" && wildcardPortErr == nil
	if value != "" && strings.ContainsAny(value[:1], "|>&*!{[") && !wildcard && ipPortErr != nil {
		return "", errors.New("控制器地址和密钥请使用单行字符串")
	}
	return value, nil
}

func (s *Server) controllerConfig() (controllerSettings, error) {
	s.controllerMu.Lock()
	defer s.controllerMu.Unlock()
	filePath := filepath.Join(s.dataDir, "config.yaml")
	info, err := os.Stat(filePath)
	if err != nil || info.Size() > 4<<20 {
		return controllerSettings{}, errors.New("无法读取控制器配置（最大 4 MB）")
	}
	if info.ModTime().Equal(s.controllerTime) && info.Size() == s.controllerSize {
		return s.controllerCache, nil
	}
	file, err := os.Open(filePath)
	if err != nil {
		return controllerSettings{}, err
	}
	defer file.Close()
	config := controllerSettings{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		key, value, found := strings.Cut(scanner.Text(), ":")
		if !found || (key != "external-controller" && key != "secret") {
			continue
		}
		parsed, err := controllerScalar(value)
		if err != nil || strings.ContainsAny(parsed, "\r\n\x00") {
			return controllerSettings{}, errors.New("控制器配置须为有效单行字符串")
		}
		if key == "external-controller" {
			config.address = parsed
		} else {
			config.secret = parsed
		}
	}
	if err := scanner.Err(); err != nil {
		return controllerSettings{}, err
	}
	host, port, err := net.SplitHostPort(config.address)
	portNumber, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || portNumber < 1 || portNumber > 65535 {
		return controllerSettings{}, errors.New("external-controller 地址或端口无效")
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "*" {
		host = "127.0.0.1"
	}
	if _, err := netip.ParseAddr(host); err != nil {
		return controllerSettings{}, errors.New("external-controller 须为 IP 地址")
	}
	config.address = net.JoinHostPort(host, port)
	s.controllerCache, s.controllerTime, s.controllerSize = config, info.ModTime(), info.Size()
	return config, nil
}

func proxyOriginAllowed(request *http.Request) bool {
	if site := request.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		return err == nil && parsed.Host == request.Host && (parsed.Scheme == "http" || parsed.Scheme == "https")
	}
	return request.Method == http.MethodGet || request.Method == http.MethodHead || strings.HasPrefix(request.Header.Get("Content-Type"), "application/json")
}

func stripPrivateHeaders(header http.Header) {
	header.Del("Cookie")
	header.Del("Origin")
	header.Del("X-Mihomo-Request")
	for name := range header {
		if strings.HasPrefix(http.CanonicalHeaderKey(name), "Tailscale-") {
			header.Del(name)
		}
	}
}

func (s *Server) handleController(writer http.ResponseWriter, request *http.Request) {
	if !proxyOriginAllowed(request) {
		writeJSON(writer, http.StatusForbidden, map[string]any{"error": "仅允许同源面板请求"})
		return
	}
	config, err := s.controllerConfig()
	if err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		ctx, cancel := context.WithCancel(request.Context())
		defer cancel()
		request = request.WithContext(ctx)
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
					if !s.originAllowed(current, who) || (!s.passwordless(current, who) && !s.validSession(request)) {
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
			proxyRequest.SetURL(&url.URL{Scheme: "http", Host: config.address})
			proxyRequest.Out.URL.Path = strings.TrimPrefix(proxyRequest.In.URL.Path, "/clash")
			proxyRequest.Out.URL.RawPath = strings.TrimPrefix(proxyRequest.In.URL.EscapedPath(), "/clash")
			query := proxyRequest.Out.URL.Query()
			query.Del("token")
			proxyRequest.Out.URL.RawQuery = query.Encode()
			stripPrivateHeaders(proxyRequest.Out.Header)
			proxyRequest.Out.Header.Set("Authorization", "Bearer "+config.secret)
		},
		ModifyResponse: func(response *http.Response) error {
			if location := response.Header.Get("Location"); location != "" {
				target, err := url.Parse(location)
				if err == nil && (target.Host == config.address || (target.Host == "" && strings.HasPrefix(target.Path, "/"))) {
					target.Scheme, target.Host = "", ""
					target.Path = "/clash" + target.Path
					target.RawPath = ""
					response.Header.Set("Location", target.String())
				}
			}
			response.Header.Del("Set-Cookie")
			return nil
		},
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, err error) {
			writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "控制器不可达：" + err.Error()})
		},
	}
	proxy.ServeHTTP(writer, request)
}
