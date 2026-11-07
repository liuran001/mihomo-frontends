package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type limitedOutput struct {
	data      []byte
	limit     int
	truncated bool
}

func (output *limitedOutput) Write(data []byte) (int, error) {
	room := max(0, output.limit-len(output.data))
	output.data = append(output.data, data[:min(room, len(data))]...)
	if len(data) > room {
		output.truncated = true
	}
	return len(data), nil
}

func deviceCommand(ctx context.Context, timeout time.Duration, limit int, executable string, args ...string) (string, string, int, bool, error) {
	return deviceCommandEnv(ctx, timeout, limit, nil, executable, args...)
}

func deviceCommandEnv(ctx context.Context, timeout time.Duration, limit int, env []string, executable string, args ...string) (string, string, int, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	if env != nil {
		command.Env = append(os.Environ(), env...)
	}
	setupProcess(command)
	defer cleanupProcess(command)
	command.WaitDelay = time.Second
	stdout := &limitedOutput{limit: limit}
	stderr := &limitedOutput{limit: min(limit, 8192)}
	command.Stdout, command.Stderr = stdout, stderr
	err := command.Run()
	code := 0
	if command.ProcessState != nil {
		code = command.ProcessState.ExitCode()
	} else if err != nil {
		code = -1
	}
	if ctx.Err() != nil {
		err = fmt.Errorf("设备操作已取消或超时：%w", ctx.Err())
	}
	return strings.ToValidUTF8(string(stdout.data), "�"), strings.ToValidUTF8(string(stderr.data), "�"), code, stdout.truncated || stderr.truncated, err
}

func androidCommand(ctx context.Context, timeout time.Duration, executable string, args ...string) (string, error) {
	output, stderr, _, truncated, err := deviceCommand(ctx, timeout, 128<<10, executable, args...)
	if err != nil {
		return "", fmt.Errorf("系统命令不可用或 ROM 不支持：%s %s", err, strings.TrimSpace(stderr))
	}
	if strings.Contains(output, "SecurityException") || strings.Contains(output, "Permission Denial") || strings.Contains(output, "Error while accessing provider") || strings.Contains(output, "Unknown command") {
		return "", errors.New(strings.TrimSpace(output))
	}
	if truncated {
		return "", errors.New("系统返回内容过长，已停止读取")
	}
	return output, nil
}

func (s *Server) readBattery(ctx context.Context) (map[string]any, error) {
	output, err := androidCommand(ctx, 5*time.Second, "dumpsys", "battery")
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if found {
			values[key] = strings.TrimSpace(value)
		}
	}
	level, levelErr := strconv.Atoi(values["level"])
	scale, scaleErr := strconv.Atoi(values["scale"])
	if levelErr != nil || scaleErr != nil || scale <= 0 {
		return nil, errors.New("系统未提供电池电量")
	}
	result := map[string]any{"percent": min(100, max(0, level*100/scale)), "status": values["status"], "powered": values["AC powered"] == "true" || values["USB powered"] == "true" || values["Wireless powered"] == "true"}
	if temperature, err := strconv.Atoi(values["temperature"]); err == nil {
		result["temperature"] = float64(temperature) / 10
	}
	if voltage, err := strconv.Atoi(values["voltage"]); err == nil {
		result["voltage"] = voltage
	}
	return result, nil
}

var smsRow = regexp.MustCompile(`(?m)^Row: [0-9]+ _id=([0-9]+), address=(.*?), date=([0-9]+), type=([0-9]+), body=`)

func (s *Server) readMessages(ctx context.Context, limit int) (map[string]any, error) {
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 50 {
		return nil, errors.New("短信条数须为 1–50")
	}
	output, err := androidCommand(ctx, 8*time.Second, "content", "query", "--uri", "content://sms", "--projection", "_id:address:date:type:body", "--sort", fmt.Sprintf("date DESC LIMIT %d", limit))
	if err != nil {
		return nil, err
	}
	list := []map[string]any{}
	rows := smsRow.FindAllStringSubmatchIndex(output, limit)
	for index, row := range rows {
		end := len(output)
		if index+1 < len(rows) {
			end = rows[index+1][0]
		}
		list = append(list, map[string]any{
			"id": output[row[2]:row[3]], "address": output[row[4]:row[5]],
			"date": output[row[6]:row[7]], "type": output[row[8]:row[9]],
			"body": strings.TrimSuffix(output[row[1]:end], "\n"),
		})
	}
	if len(list) == 0 && !strings.Contains(output, "No result found") {
		return nil, errors.New("ROM 未返回可解析的短信，可能限制了 root 读取短信")
	}
	return map[string]any{"messages": list}, nil
}

// hotspotConfig 是要写入系统的热点设置；未提供的字段保持系统当前值。
// Security 按 SoftApConfiguration：0 开放、1 WPA2、2 WPA3 过渡（WPA2/WPA3）、3 WPA3。
// Band 为位掩码：1 2.4 GHz、2 5 GHz、3 两者。Password 为空时沿用系统当前密码。
type hotspotConfig struct {
	SSID     *string `json:"ssid,omitempty"`
	Password string  `json:"password,omitempty"`
	Security *int    `json:"security,omitempty"`
	Band     *int    `json:"band,omitempty"`
	Hidden   *bool   `json:"hidden,omitempty"`
}

type hotspotRequest struct {
	Enabled *bool          `json:"enabled"`
	Config  *hotspotConfig `json:"config"`
}

func (config hotspotConfig) validate() error {
	if config.SSID != nil {
		ssid := *config.SSID
		if len(ssid) < 1 || len(ssid) > 32 || !utf8.ValidString(ssid) || strings.ContainsAny(ssid, "\r\n\x00") {
			return errors.New("热点名称须为 1–32 字节，不能含换行")
		}
	}
	if config.Security != nil && (*config.Security < 0 || *config.Security > 3) {
		return errors.New("加密方式无效")
	}
	if config.Password != "" {
		if config.Security != nil && *config.Security == 0 {
			return errors.New("开放热点不需要密码")
		}
		if len(config.Password) < 8 || len(config.Password) > 63 {
			return errors.New("热点密码须为 8–63 个 ASCII 字符")
		}
		for _, character := range config.Password {
			if character < 32 || character > 126 {
				return errors.New("热点密码须为可打印 ASCII 字符")
			}
		}
		if config.Security == nil {
			return errors.New("修改密码时需要同时指定加密方式")
		}
	}
	if config.Band != nil && *config.Band != 1 && *config.Band != 2 && *config.Band != 3 {
		return errors.New("热点频段须为 2.4 GHz、5 GHz 或两者")
	}
	if config.SSID == nil && config.Security == nil && config.Band == nil && config.Hidden == nil {
		return errors.New("没有要修改的热点设置")
	}
	return nil
}

// readHotspot 读取系统热点状态、系统保存的热点配置（名称、密码、加密、频段）与已连接设备。
func (s *Server) readHotspot(ctx context.Context) (map[string]any, error) {
	result, err := s.hotspotCommand(ctx, "status", "")
	if err != nil {
		return nil, err
	}
	s.addHotspotClients(ctx, result)
	return result, nil
}

// addHotspotClients 从热点网卡的邻居表（ip neigh）列出已连接设备，与 VPNHotspot 的做法相同。
func (s *Server) addHotspotClients(ctx context.Context, result map[string]any) {
	ifaces, _ := result["ifaces"].([]any)
	clients := []map[string]any{}
	for _, item := range ifaces {
		iface, ok := item.(string)
		if !ok || iface == "" || strings.ContainsAny(iface, " /\x00") {
			continue
		}
		output, _, _, _, err := deviceCommand(ctx, 3*time.Second, 64<<10, "ip", "neigh", "show", "dev", iface)
		if err != nil {
			continue
		}
		clients = append(clients, parseNeighbours(output, iface)...)
	}
	result["clients"] = clients
}

func parseNeighbours(output, iface string) []map[string]any {
	byMAC := map[string]map[string]any{}
	order := []string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		state := fields[len(fields)-1]
		if state == "FAILED" || state == "INCOMPLETE" || state == "NOARP" {
			continue
		}
		mac := ""
		for index := 1; index+1 < len(fields); index++ {
			if fields[index] == "lladdr" {
				mac = strings.ToLower(fields[index+1])
			}
		}
		if mac == "" {
			continue
		}
		entry, ok := byMAC[mac]
		if !ok {
			entry = map[string]any{"mac": mac, "iface": iface, "ipv4": "", "ipv6": []string{}, "state": state}
			byMAC[mac] = entry
			order = append(order, mac)
		}
		if strings.Contains(fields[0], ":") {
			if !strings.HasPrefix(fields[0], "fe80:") {
				entry["ipv6"] = append(entry["ipv6"].([]string), fields[0])
			}
		} else {
			entry["ipv4"] = fields[0]
		}
		if state == "REACHABLE" {
			entry["state"] = state
		}
	}
	clients := make([]map[string]any, 0, len(order))
	for _, mac := range order {
		clients = append(clients, byMAC[mac])
	}
	return clients
}

func (s *Server) hotspotCommand(ctx context.Context, action, path string) (map[string]any, error) {
	helper := filepath.Join(filepath.Dir(s.scriptDir), "bin", "device-control.jar")
	if _, err := os.Stat(helper); err != nil {
		return nil, errors.New("缺少设备控制桥接，请重新安装完整模块")
	}
	args := []string{"/system/bin", "mihomo.device.DeviceControl", action}
	timeout := 8 * time.Second
	switch action {
	case "start":
		timeout = 22 * time.Second
	case "stop":
		timeout = 10 * time.Second
	case "config":
		args = append(args, path)
	}
	output, stderr, _, truncated, err := deviceCommandEnv(ctx, timeout, 16<<10, []string{"CLASSPATH=" + helper}, "app_process", args...)
	var result map[string]any
	if decodeErr := json.Unmarshal([]byte(output), &result); decodeErr == nil && result != nil && !truncated {
		if message, ok := result["error"].(string); ok && message != "" {
			return nil, errors.New(message)
		}
		if result["ok"] == true && err == nil {
			return result, nil
		}
	}
	return nil, fmt.Errorf("热点操作未确认（ROM 可能不支持）：%v %s", err, strings.TrimSpace(stderr))
}

// setHotspot 修改系统热点配置（写入系统，等同于在系统设置里修改）和/或开关热点。
// 密码经私有临时文件传给桥接，不出现在命令行参数里，用完即删。
func (s *Server) setHotspot(ctx context.Context, body hotspotRequest) (map[string]any, error) {
	if body.Enabled == nil && body.Config == nil {
		return nil, errors.New("缺少热点配置或开关")
	}
	var result map[string]any
	if body.Config != nil {
		if err := body.Config.validate(); err != nil {
			return nil, err
		}
		data, _ := json.Marshal(body.Config)
		path := filepath.Join(s.dataDir, "run", "webui-hotspot.json")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		if err := writePrivateFile(path, data); err != nil {
			return nil, err
		}
		saved, err := s.hotspotCommand(ctx, "config", path)
		_ = os.Remove(path)
		if err != nil {
			return nil, err
		}
		result = saved
	}
	if body.Enabled != nil {
		action := "stop"
		if *body.Enabled {
			action = "start"
		}
		changed, err := s.hotspotCommand(ctx, action, "")
		if err != nil {
			return nil, err
		}
		result = changed
	}
	s.addHotspotClients(ctx, result)
	return result, nil
}

func writePrivateFile(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".webui-device-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

type terminalRequest struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}

func (s *Server) runTerminal(ctx context.Context, body terminalRequest) (map[string]any, error) {
	if len(body.Command) == 0 || len(body.Command) > 8192 || strings.ContainsRune(body.Command, 0) || !utf8.ValidString(body.Command) {
		return nil, errors.New("命令须为 1–8192 字节")
	}
	if body.Timeout == 0 {
		body.Timeout = 15
	}
	if body.Timeout < 1 || body.Timeout > 60 {
		return nil, errors.New("终端超时须为 1–60 秒")
	}
	stdout, stderr, code, truncated, err := deviceCommand(ctx, time.Duration(body.Timeout)*time.Second, 128<<10, s.shell, "-c", body.Command)
	result := map[string]any{"stdout": stdout, "stderr": stderr, "errno": code, "truncated": truncated}
	if err != nil && code == -1 {
		result["stderr"] = strings.TrimSpace(stderr + "\n" + err.Error())
	}
	return result, nil
}
