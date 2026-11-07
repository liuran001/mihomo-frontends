package main

// Tailscale（内核 tailscale 出站，tsnet）登录辅助（scripts/tailscale.sh 的 state、login 转发到这里）。
//   state DIR                 读取 DIR/tailscaled.state 中的登录资料（只输出 _current-profile 与 _profiles，不碰 _machinekey）
//   login CTL PATH NAME [S]   订阅控制器日志并发起一次测速唤醒 tsnet，等待最多 S 秒（默认 20）：
//                             输出 {"ok":true,"url":"https://…"} 或 {"ok":true,"url":null,"running":true|false}
//                             CTL 为 http://127.0.0.1:端口，PATH 为 URL 编码后的出站名，NAME 为日志中 JSON 转义后的出站名；
//                             控制器密钥通过环境变量 MIHOMO_SECRET 传入

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func tailscaleCommand(env toolEnv, args []string) (obj, error) {
	if len(args) == 0 {
		return nil, errors.New("用法: tailscale.sh state|login|logout|open ...")
	}
	switch args[0] {
	case "state":
		if len(args) != 2 {
			return nil, errors.New("参数无效")
		}
		return tailscaleState(env, args[1])
	case "login":
		if len(args) < 4 || len(args) > 5 {
			return nil, errors.New("参数无效")
		}
		wait := "20"
		if len(args) == 5 {
			wait = args[4]
		}
		return tailscaleLoginLink(args[1], args[2], args[3], wait, os.Getenv("MIHOMO_SECRET"))
	}
	return nil, errors.New("用法: tailscale.sh state|login|logout|open ...")
}

// insideData 要求状态目录在数据目录之内
func insideData(data, dir string) bool {
	if !strings.HasPrefix(dir, data+"/") || len(dir) == len(data)+1 {
		return false
	}
	return !strings.Contains(dir+"/", "/../") && !strings.Contains(dir+"/", "/./")
}

var base64Value = regexp.MustCompile(`^[A-Za-z0-9+/=]*$`)

func tailscaleState(env toolEnv, dir string) (obj, error) {
	if !insideData(env.data, dir) {
		return nil, errors.New("状态目录必须在数据目录之内")
	}
	data, err := os.ReadFile(filepath.Join(dir, "tailscaled.state"))
	if err != nil {
		return okObj(field{"exists", false}), nil
	}
	var state map[string]any
	_ = json.Unmarshal(data, &state)
	value := func(key string) string {
		text, _ := state[key].(string)
		if !base64Value.MatchString(text) {
			return ""
		}
		return text
	}
	return okObj(field{"exists", true}, field{"current", value("_current-profile")}, field{"profiles", value("_profiles")}), nil
}

var (
	localController = regexp.MustCompile(`^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]`)
	encodedName     = regexp.MustCompile(`^[A-Za-z0-9%._~-]+$`)
	loginURL        = regexp.MustCompile(`go to: (https?://[^" \\]*)`)
)

func tailscaleLoginLink(controller, path, name, wait, secret string) (obj, error) {
	if !localController.MatchString(controller) {
		return nil, errors.New("控制器地址必须是本机")
	}
	if !encodedName.MatchString(path) {
		return nil, errors.New("出站名编码无效")
	}
	seconds, err := strconv.Atoi(wait)
	if err != nil || seconds < 0 || strings.Trim(wait, "0123456789") != "" {
		return nil, errors.New("等待时间无效")
	}
	if name == "" {
		return nil, errors.New("缺少出站名")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()
	// 只连本机控制器，不走任何代理
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	request := func(ctx context.Context, address string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		return client.Do(req)
	}

	// 有订阅者时内核会输出 info 日志，与配置中的 log-level 无关；tsnet 只在首次连接时启动，所以先订阅再测速
	lines := make(chan string, 64)
	subscribed := make(chan struct{})
	go func() {
		defer close(lines)
		response, err := request(ctx, controller+"/logs?level=info")
		close(subscribed)
		if err != nil {
			return
		}
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		select {
		case <-subscribed:
		case <-time.After(time.Second):
		}
		probeCtx, probeCancel := context.WithTimeout(ctx, 10*time.Second)
		defer probeCancel()
		if response, err := request(probeCtx, controller+"/proxies/"+path+"/delay?url=http%3A%2F%2F100.100.100.100&timeout=8000"); err == nil {
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
	}()

	marker := "[Tailscale](" + name + ") "
	running := false
	for line := range lines {
		if !strings.Contains(line, marker) {
			continue
		}
		if matches := loginURL.FindAllStringSubmatch(line, -1); matches != nil {
			return okObj(field{"url", matches[len(matches)-1][1]}), nil
		}
		if strings.Contains(line, "AuthLoop: state is Running") {
			running = true
			break
		}
	}
	return okObj(field{"url", nil}, field{"running", running}), nil
}
