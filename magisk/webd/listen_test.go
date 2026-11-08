package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func reachable(port int) bool {
	client := &http.Client{Timeout: 500 * time.Millisecond, Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/")
	if err != nil {
		return false
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	return true
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时：" + what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 运行中的服务自己跟随设置：换端口后旧端口立即不可用，关闭网页管理后退出
func TestListenFollows(t *testing.T) {
	saved := configPollInterval
	configPollInterval = 30 * time.Millisecond
	defer func() { configPollInterval = saved }()
	first, second := freePort(t), freePort(t)
	config := defaultConfig()
	config.Enabled, config.Port = true, first
	f := newFixture(t, config, "")
	configPath := filepath.Join(f.dir, "data", "webui.json")

	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { done <- f.server.listen(ctx, "") }()
	waitFor(t, "监听第一个端口", func() bool { return reachable(first) })

	// 旧端口上的长连接也要断开：先建一个保持着的连接
	idle, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(first))
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()

	if err := updateConfig(configPath, func(c *Config) error { c.Port = second; return nil }); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "换到新端口", func() bool { return reachable(second) })
	waitFor(t, "旧端口关闭", func() bool { return !reachable(first) })
	idle.SetReadDeadline(time.Now().Add(7 * time.Second))
	if _, err := idle.Read(make([]byte, 1)); err == nil {
		t.Fatal("旧端口上的连接应被关闭")
	}

	if err := updateConfig(configPath, func(c *Config) error { c.Enabled = false; return nil }); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("关闭网页管理后应正常退出：%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("关闭网页管理后服务没有退出")
	}
	if reachable(second) {
		t.Fatal("退出后端口仍可访问")
	}
}

// 新端口被占用时继续用旧端口，不中断服务
func TestListenBusyPort(t *testing.T) {
	saved := configPollInterval
	configPollInterval = 30 * time.Millisecond
	defer func() { configPollInterval = saved }()
	first := freePort(t)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	config := defaultConfig()
	config.Enabled, config.Port = true, first
	f := newFixture(t, config, "")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.server.listen(ctx, "") }()
	waitFor(t, "监听第一个端口", func() bool {
		select {
		case err := <-done:
			t.Fatalf("服务提前退出：%v", err)
		default:
		}
		return reachable(first)
	})
	if err := updateConfig(filepath.Join(f.dir, "data", "webui.json"), func(c *Config) error {
		c.Port = busy.Addr().(*net.TCPAddr).Port
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if !reachable(first) {
		t.Fatal("新端口不可用时应保留旧端口")
	}
	cancel()
	<-done
}

// 关闭网页管理时增强功能保留（管理器里照常可用），只关掉经网页管理打开的 web scrcpy；服务仍需运行
func TestDisablingWebUIKeepsEnhanced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "webui.json")
	config := defaultConfig()
	config.Enabled = true
	hash, _ := hashPassword("secret-pass")
	config.Password = hash
	config.Enhanced.Enabled, config.Enhanced.Scrcpy = true, true
	if err := saveConfig(path, config); err != nil {
		t.Fatal(err)
	}
	if err := setConfig(path, "eyJlbmFibGVkIjpmYWxzZX0="); err != nil { // {"enabled":false}
		t.Fatal(err)
	}
	loaded, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Enabled || !loaded.Enhanced.Enabled || loaded.Enhanced.Scrcpy || !loaded.serviceNeeded() {
		t.Fatalf("关闭网页管理后应保留增强功能、关闭 web scrcpy：%+v", loaded.Enhanced)
	}
}
