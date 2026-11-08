package main

import (
	"context"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// webui.sh set 保存后发 SIGHUP：不等定时检查，立刻换到新端口
func TestListenFollowsOnSignal(t *testing.T) {
	saved := configPollInterval
	configPollInterval = time.Hour
	defer func() { configPollInterval = saved }()
	first, second := freePort(t), freePort(t)
	config := defaultConfig()
	config.Enabled, config.Port = true, first
	f := newFixture(t, config, "")
	configPath := filepath.Join(f.dir, "data", "webui.json")

	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { done <- f.server.listen(ctx, "") }()
	defer func() { cancel(); <-done }()
	waitFor(t, "监听第一个端口", func() bool { return reachable(first) })

	if err := updateConfig(configPath, func(c *Config) error { c.Port = second; return nil }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if reachable(second) {
		t.Fatal("没有收到通知就换了端口（定时检查应为一小时）")
	}
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "收到 SIGHUP 后换到新端口", func() bool { return reachable(second) })
	waitFor(t, "旧端口关闭", func() bool { return !reachable(first) })
}
