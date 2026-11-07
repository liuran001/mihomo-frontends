package main

// 原先写在 shell 脚本里的工具子命令（内核更新、模块更新、Tailscale 登录、连通性检测、release 解析）。
// scripts/*.sh 只保留同名入口并转发到这里，网页与 bridge 的调用方式不变。
//
//	mihomo-webd core      -data DIR check|download [force]|info|rollback|settings REPO TAG MIRROR|get_settings
//	mihomo-webd module    -data DIR -moddir DIR check|upgrade [force]|current
//	mihomo-webd tailscale -data DIR state DIR|login CTL PATH NAME [SECONDS]
//	mihomo-webd net       -data DIR netcheck|exitip
//	mihomo-webd release   -data DIR tag REPO|node REPO ARCH MAJOR   （输出纯文本，供 substore.sh 使用）
//
// 网络下载仍交给 curl：CGO 关闭的 Go 程序在 Android 上读不到 /etc/resolv.conf，内核没运行时自己解析域名不可靠；
// 只有访问本机控制器（127.0.0.1）的 Tailscale 登录直接用 net/http。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var errLockBusy = errors.New("锁被占用")

type toolEnv struct {
	data   string
	moddir string
}

func (e toolEnv) runDir() string   { return filepath.Join(e.data, "run") }
func (e toolEnv) settings() string { return filepath.Join(e.data, "settings.ini") }
func (e toolEnv) bin() string      { return filepath.Join(e.data, "mihomo") }
func (e toolEnv) binPrev() string  { return filepath.Join(e.data, "mihomo.prev") }
func (e toolEnv) config() string   { return filepath.Join(e.data, "config.yaml") }

func (e toolEnv) setting(key, fallback string) string {
	return settingGet(e.settings(), key, fallback)
}

func (e toolEnv) mirror() string { return e.setting("core_mirror", "") }

// ensureDirs 与 common.sh 的 ensure_dirs 一致
func (e toolEnv) ensureDirs() error {
	for _, dir := range []string{e.data, filepath.Join(e.data, "backup"), e.runDir()} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	_ = os.Chmod(e.data, 0o700)
	return os.Chmod(e.runDir(), 0o700)
}

// lockBackend 与 shell 的 lock_backend 用同一个锁文件（flock），最多等 60 秒
func (e toolEnv) lockBackend() (func(), error) {
	if err := e.ensureDirs(); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(e.runDir(), "backend.lock"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFileWait(file, backendLockTimeout); err != nil {
		file.Close()
		return nil, err
	}
	return func() { unlockConfigFile(file); file.Close() }, nil
}

var backendLockTimeout = 60 * time.Second

// field / obj：按给定顺序输出 JSON 对象（与原脚本的输出逐字一致，便于脚本测试比对）
type field struct {
	key   string
	value any
}

type obj []field

func (o obj) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for index, item := range o {
		if index > 0 {
			out.WriteByte(',')
		}
		key, _ := marshalPlain(item.key)
		value, err := marshalPlain(item.value)
		if err != nil {
			return nil, err
		}
		out.Write(key)
		out.WriteByte(':')
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

func marshalPlain(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(out.Bytes(), "\n"), nil
}

func emitObj(value obj) {
	data, _ := marshalPlain(value)
	fmt.Println(string(data))
}

func okObj(fields ...field) obj { return append(obj{{"ok", true}}, fields...) }

// runTool 处理工具子命令；不是工具子命令时返回 false
func runTool(name string, argv []string) bool {
	commands := map[string]func(toolEnv, []string) (obj, error){
		"core":      coreCommand,
		"module":    moduleCommand,
		"tailscale": tailscaleCommand,
		"net":       netCommand,
	}
	command, isJSON := commands[name]
	if !isJSON && name != "release" {
		return false
	}
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	data := flags.String("data", "/data/adb/mihomo", "数据目录")
	moddir := flags.String("moddir", "/data/adb/modules/mihomo-ebpf", "模块目录")
	if err := flags.Parse(argv); err != nil {
		fail(err)
	}
	env := toolEnv{data: *data, moddir: *moddir}
	if name == "release" {
		text, err := releaseCommand(env, flags.Args())
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		if text != "" {
			fmt.Println(text)
		}
		os.Exit(0)
	}
	result, err := command(env, flags.Args())
	if err != nil {
		emitObj(obj{{"ok", false}, {"error", err.Error()}})
		os.Exit(1)
	}
	emitObj(result)
	os.Exit(0)
	return true
}

// ---------- settings.ini ----------

// settingGet 取第一行 key=value 的值，与 common.sh 的 setting_get 一致
func settingGet(path, key, fallback string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, key+"=") {
			return strings.TrimSuffix(line[len(key)+1:], "\r")
		}
	}
	return fallback
}

func validSettingKey(key string) bool {
	if key == "" {
		return false
	}
	for _, char := range key {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_') {
			return false
		}
	}
	return true
}

func hasControl(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] == 0x7f {
			return true
		}
	}
	return false
}

// settingsPut 原子地改写设置文件：去掉这些键的旧行，在末尾追加新值。调用方须持有后台锁。
func settingsPut(path, tmpDir string, pairs ...[2]string) error {
	for _, pair := range pairs {
		if !validSettingKey(pair[0]) || hasControl(pair[1]) {
			return errors.New("设置格式无效")
		}
	}
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var out strings.Builder
	text := strings.TrimSuffix(string(existing), "\n")
	if text != "" {
		for _, line := range strings.Split(text, "\n") {
			drop := false
			for _, pair := range pairs {
				if strings.HasPrefix(line, pair[0]+"=") {
					drop = true
					break
				}
			}
			if !drop {
				out.WriteString(line + "\n")
			}
		}
	}
	for _, pair := range pairs {
		out.WriteString(pair[0] + "=" + pair[1] + "\n")
	}
	return writeFileAtomic(path, tmpDir, []byte(out.String()), 0o600)
}

func writeFileAtomic(path, tmpDir string, data []byte, mode os.FileMode) error {
	if tmpDir == "" {
		tmpDir = filepath.Dir(path)
	}
	file, err := os.CreateTemp(tmpDir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr == nil {
		writeErr = os.Chmod(name, mode)
	}
	if writeErr == nil {
		writeErr = os.Rename(name, path)
	}
	if writeErr != nil {
		os.Remove(name)
	}
	return writeErr
}

// ---------- curl ----------

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0
}

// curlPath 优先系统自带的 /system/bin/curl，其次 PATH 里的
func curlPath() (string, error) {
	if isExecutable("/system/bin/curl") {
		return "/system/bin/curl", nil
	}
	path, err := exec.LookPath("curl")
	if err != nil {
		return "", errors.New("缺少 curl")
	}
	return path, nil
}

const maxFetchBytes = 16 << 20

// fetchBytes 依次尝试各个地址，返回第一个成功且非空的响应体（测试可替换）
var fetchBytes = func(maxTime int, urls ...string) ([]byte, error) {
	curl, err := curlPath()
	if err != nil {
		return nil, err
	}
	var last error = errors.New("没有可用的地址")
	for _, address := range urls {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(maxTime+5)*time.Second)
		command := exec.CommandContext(ctx, curl, "-fsSL", "-m", fmt.Sprint(maxTime), "--", address)
		out := &limitedBuffer{limit: maxFetchBytes}
		command.Stdout = out
		err := command.Run()
		cancel()
		if err == nil && out.Len() > 0 && !out.truncated {
			return out.Bytes(), nil
		}
		last = errors.New("下载失败")
	}
	return nil, last
}

type limitedBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if room := b.limit - b.Len(); room < len(data) {
		if room > 0 {
			b.Buffer.Write(data[:room])
		}
		b.truncated = true
		return len(data), nil
	}
	return b.Buffer.Write(data)
}

// downloadFile 用 curl 下载到 dest（依次尝试各个地址；测试可替换）
var downloadFile = func(maxTime int, dest string, urls ...string) error {
	curl, err := curlPath()
	if err != nil {
		return err
	}
	for _, address := range urls {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(maxTime+5)*time.Second)
		command := exec.CommandContext(ctx, curl, "-fsSL", "-m", fmt.Sprint(maxTime), "-o", dest, "--", address)
		err := command.Run()
		cancel()
		if info, statErr := os.Stat(dest); err == nil && statErr == nil && info.Size() > 0 {
			return nil
		}
	}
	return errors.New("下载失败")
}

// withMirror 返回先镜像、后直连的地址列表
func withMirror(mirror, address string) []string {
	if mirror == "" {
		return []string{address}
	}
	return []string{mirror + address, address}
}

// firstLine 运行程序并取标准输出的第一行（最多等 timeout）
func firstLine(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	line, _, _ := strings.Cut(string(out), "\n")
	return strings.TrimSuffix(line, "\r"), err
}

func combinedOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
