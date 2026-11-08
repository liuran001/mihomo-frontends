// mihomo-webd：模块网页的局域网 / Tailscale 管理服务。
//
//	mihomo-webd serve  -c CONF -root WEBROOT -scripts DIR -data DIR [-socket PATH]
//	mihomo-webd get    -c CONF            输出设置（不含密码）与本机地址
//	mihomo-webd set    -c CONF B64JSON    更新设置（只接受已知字段，不改密码）
//	mihomo-webd passwd -c CONF B64        设置密码；空串清除密码
//	mihomo-webd addrs                     输出本机可用于访问的地址
//	mihomo-webd enabled -c CONF           网页管理已启用时退出码为 0（不输出）
//	mihomo-webd core|module|tailscale|net|release …   模块脚本转发的工具子命令，见 tools.go
//
// 子命令的输出都是一行 JSON：{"ok":true,...} 或 {"ok":false,"error":"..."}。
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"unicode/utf8"
)

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("用法: mihomo-webd serve|get|set|passwd|addrs|core|module|tailscale|net|release"))
	}
	// 由模块脚本转发的工具子命令（见 tools.go）
	if runTool(os.Args[1], os.Args[2:]) {
		return
	}
	flags := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
	configPath := flags.String("c", "/data/adb/mihomo/webui.json", "设置文件")
	webroot := flags.String("root", "/data/adb/modules/mihomo-ebpf/webroot", "网页目录")
	scriptDir := flags.String("scripts", "/data/adb/modules/mihomo-ebpf/scripts", "脚本目录")
	dataDir := flags.String("data", "/data/adb/mihomo", "数据目录")
	socket := flags.String("socket", "/data/adb/mihomo/run/webui.sock", "Tailscale serve 使用的 unix socket（空则不监听）")
	if err := flags.Parse(os.Args[2:]); err != nil {
		fail(err)
	}
	args := flags.Args()
	switch os.Args[1] {
	case "assets":
		fail(prepareScrcpyAssets(*dataDir))
	case "serve":
		serve(*configPath, *webroot, *scriptDir, *dataDir, *socket)
	case "get":
		config, err := loadConfig(*configPath)
		if err != nil {
			fail(err)
		}
		out := publicConfig(config)
		out["ok"] = true
		out["addrs"] = localAddrs()
		emit(out)
	case "set":
		if len(args) != 1 {
			fail(errors.New("缺少设置"))
		}
		before, _ := loadConfig(*configPath)
		if err := setConfig(*configPath, args[0]); err != nil {
			fail(err)
		}
		// 一次返回新设置，脚本不必再调用 get；端口或局域网监听变化时需要重启服务
		config, err := loadConfig(*configPath)
		if err != nil {
			fail(err)
		}
		out := publicConfig(config)
		out["ok"] = true
		out["addrs"] = localAddrs()
		out["listen_changed"] = before.Port != config.Port || before.LAN != config.LAN
		emit(out)
	case "passwd":
		if len(args) != 1 {
			fail(errors.New("缺少密码"))
		}
		fail(setPassword(*configPath, args[0]))
	case "enhanced-set":
		if len(args) != 1 {
			fail(errors.New("缺少增强功能设置"))
		}
		fail(setEnhancedConfig(*configPath, args[0]))
	case "enhanced-request":
		if len(args) != 2 {
			fail(errors.New("缺少增强操作参数"))
		}
		response, err := localEnhancedRequest(*dataDir, args[0], args[1])
		if err != nil {
			fail(err)
		}
		emit(response)
	case "addrs":
		emit(map[string]any{"ok": true, "addrs": localAddrs()})
	case "enabled":
		// 服务是否需要运行（网页管理或增强功能任一启用）：退出码 0 为需要。脚本不要自己 grep webui.json，增强功能里也有 enabled 字段
		config, err := loadConfig(*configPath)
		if err != nil || !config.serviceNeeded() {
			os.Exit(1)
		}
		os.Exit(0)
	default:
		fail(fmt.Errorf("未知子命令 %s", os.Args[1]))
	}
}

func emit(value any) {
	data, _ := json.Marshal(value)
	fmt.Println(string(data))
}

// fail 输出错误 JSON 并退出；err 为 nil 时输出 {"ok":true}。
func fail(err error) {
	if err == nil {
		emit(map[string]any{"ok": true})
		os.Exit(0)
	}
	emit(map[string]any{"ok": false, "error": err.Error()})
	os.Exit(1)
}

func decodeArg(value string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, errors.New("参数不是 base64")
	}
	return data, nil
}

func setConfig(path, encoded string) error {
	data, err := decodeArg(encoded)
	if err != nil {
		return err
	}
	var patch struct {
		Enabled             *bool     `json:"enabled"`
		Port                *int      `json:"port"`
		LAN                 *bool     `json:"lan"`
		AllowCIDRs          *[]string `json:"allow_cidrs"`
		RequirePassword     *bool     `json:"require_password"`
		Tailscale           *bool     `json:"tailscale"`
		TailscaleNoPassword *bool     `json:"tailscale_no_password"`
		TailscaleUsers      *[]string `json:"tailscale_users"`
		SessionHours        *int      `json:"session_hours"`
	}
	if err := decodeStrict(strings.NewReader(string(data)), &patch); err != nil {
		return fmt.Errorf("设置无效：%w", err)
	}
	return updateConfig(path, func(config *Config) error {
		assign := func(target *bool, value *bool) {
			if value != nil {
				*target = *value
			}
		}
		assign(&config.Enabled, patch.Enabled)
		// web scrcpy 经网页管理的端口打开，关闭网页管理时一并关闭；增强功能本身不受影响（管理器里照常可用）
		if !config.Enabled {
			config.Enhanced.Scrcpy = false
		}
		assign(&config.LAN, patch.LAN)
		assign(&config.RequirePassword, patch.RequirePassword)
		assign(&config.Tailscale, patch.Tailscale)
		assign(&config.TailscaleNoPassword, patch.TailscaleNoPassword)
		if patch.Port != nil {
			config.Port = *patch.Port
		}
		if patch.SessionHours != nil {
			config.SessionHours = *patch.SessionHours
		}
		if patch.AllowCIDRs != nil {
			config.AllowCIDRs = *patch.AllowCIDRs
		}
		if patch.TailscaleUsers != nil {
			config.TailscaleUsers = *patch.TailscaleUsers
		}
		return nil
	})
}

func setPassword(path, encoded string) error {
	data, err := decodeArg(encoded)
	if err != nil {
		return err
	}
	password := string(data)
	return updateConfig(path, func(config *Config) error {
		if password == "" {
			// 没有主密码时其它设备不能使用增强功能（见 enhancedAllowed），管理器里照常可用
			config.Password = nil
			config.Enhanced.Scrcpy = false
			return nil
		}
		if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 6 || len(password) > 256 {
			return errors.New("密码须为 6–256 个字符")
		}
		hash, err := hashPassword(password)
		if err != nil {
			return err
		}
		config.Password = hash
		return nil
	})
}

// localAddrs 列出非回环的 IPv4 与全局 IPv6 地址，供设置页显示访问链接。
func localAddrs() []map[string]string {
	list := []map[string]string{}
	interfaces, err := net.Interfaces()
	if err != nil {
		return list
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			prefix, err := netip.ParsePrefix(addr.String())
			if err != nil {
				continue
			}
			ip := prefix.Addr().Unmap()
			if ip.IsLinkLocalUnicast() || ip.IsLoopback() || (ip.Is6() && !ip.IsGlobalUnicast()) {
				continue
			}
			list = append(list, map[string]string{"iface": iface.Name, "addr": ip.String()})
		}
	}
	return list
}

func serve(configPath, webroot, scriptDir, dataDir, socket string) {
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("[webd] ")
	server, err := newServer(configPath, webroot, scriptDir, dataDir)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.listen(ctx, socket); err != nil {
		log.Fatal(err)
	}
}
