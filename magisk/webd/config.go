package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var configUpdateAccess sync.Mutex

func updateConfig(path string, update func(*Config) error) error {
	configUpdateAccess.Lock()
	defer configUpdateAccess.Unlock()
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lockConfigFile(lock); err != nil {
		return err
	}
	defer unlockConfigFile(lock)
	config, err := loadConfig(path)
	if err != nil {
		return err
	}
	if err := update(&config); err != nil {
		return err
	}
	return saveConfig(path, config)
}

// Config 是 webui.json：网页管理的全部设置。密码只存 PBKDF2-SHA256 派生值。
type Config struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
	// LAN 为 true 时监听所有地址，否则只监听 127.0.0.1
	LAN bool `json:"lan"`
	// AllowCIDRs 限制局域网来源；为空时只允许私网地址（RFC 1918、链路本地、ULA）
	AllowCIDRs []string `json:"allow_cidrs"`
	// RequirePassword 为 false（或没有设置密码）时本机与局域网来源免密
	RequirePassword bool `json:"require_password"`
	// Tailscale 为 true 时接受内核 tailscale serve 经 unix socket 转发的请求
	Tailscale bool `json:"tailscale"`
	// TailscaleNoPassword 为 true 时带 Tailnet 身份的请求免密
	TailscaleNoPassword bool `json:"tailscale_no_password"`
	// TailscaleUsers 为空时允许 Tailnet 中的任何账号，否则只允许列出的登录名
	TailscaleUsers []string       `json:"tailscale_users"`
	SessionHours   int            `json:"session_hours"`
	Password       *Hash          `json:"password,omitempty"`
	Enhanced       EnhancedConfig `json:"enhanced"`
}

type Hash struct {
	Salt       string `json:"salt"`
	Key        string `json:"key"`
	Iterations int    `json:"iterations"`
}

func passwordConfigID(config Config) string {
	if config.Password == nil {
		return ""
	}
	return fmt.Sprintf("%d:%s:%s", config.Password.Iterations, config.Password.Salt, config.Password.Key)
}

const (
	defaultPort       = 9099
	defaultIterations = 210000
	maxListItems      = 64
)

var loginNamePattern = regexp.MustCompile(`^[^\s,]{1,254}$`)

var privatePrefixes = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

func defaultConfig() Config {
	return Config{Port: defaultPort, RequirePassword: true, SessionHours: 168, AllowCIDRs: []string{}, TailscaleUsers: []string{}}
}

func loadConfig(path string) (Config, error) {
	config := defaultConfig()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, err
	}
	if err := decodeStrict(strings.NewReader(string(data)), &config); err != nil {
		return defaultConfig(), fmt.Errorf("webui.json 无效：%w", err)
	}
	if err := config.validate(); err != nil {
		return defaultConfig(), err
	}
	return config, nil
}

func saveConfig(path string, config Config) error {
	if err := config.validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".webui-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// serviceNeeded：网页管理或增强功能任一启用时服务要运行；只开增强功能时不监听 TCP，只提供管理器用的 unix socket。
func (c Config) serviceNeeded() bool { return c.Enabled || c.Enhanced.Enabled }

func (c *Config) validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("端口须为 1–65535")
	}
	if c.SessionHours < 1 || c.SessionHours > 24*90 {
		return errors.New("登录有效期须为 1–2160 小时")
	}
	if c.AllowCIDRs == nil {
		c.AllowCIDRs = []string{}
	}
	if c.TailscaleUsers == nil {
		c.TailscaleUsers = []string{}
	}
	if len(c.AllowCIDRs) > maxListItems || len(c.TailscaleUsers) > maxListItems {
		return fmt.Errorf("列表最多 %d 项", maxListItems)
	}
	for i, cidr := range c.AllowCIDRs {
		prefix, err := parsePrefix(cidr)
		if err != nil {
			return fmt.Errorf("网段 %q 无效", cidr)
		}
		c.AllowCIDRs[i] = prefix.String()
	}
	for _, user := range c.TailscaleUsers {
		if !loginNamePattern.MatchString(user) {
			return fmt.Errorf("Tailnet 账号 %q 无效", user)
		}
	}
	if c.Password != nil && !c.Password.valid() {
		return errors.New("密码数据无效")
	}
	if c.Enhanced.Scrcpy && c.Enhanced.ScrcpyPort == c.Port {
		return errors.New("web scrcpy 端口不能等于网页管理端口")
	}
	return c.Enhanced.validate()
}

// parsePrefix 接受 CIDR 或单个地址（视为 /32、/128）。
func parsePrefix(value string) (netip.Prefix, error) {
	value = strings.TrimSpace(value)
	if strings.Contains(value, "/") {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return netip.Prefix{}, err
		}
		return prefix.Masked(), nil
	}
	addr, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Prefix{}, err
	}
	return netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen()), nil
}

func (c *Config) prefixes() []netip.Prefix {
	if len(c.AllowCIDRs) == 0 {
		return privatePrefixes
	}
	list := make([]netip.Prefix, 0, len(c.AllowCIDRs))
	for _, cidr := range c.AllowCIDRs {
		if prefix, err := parsePrefix(cidr); err == nil {
			list = append(list, prefix)
		}
	}
	return list
}

func (c *Config) lanAllowed(addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, prefix := range c.prefixes() {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func (c *Config) tailscaleUserAllowed(login string) bool {
	if login == "" {
		return false
	}
	if len(c.TailscaleUsers) == 0 {
		return true
	}
	for _, user := range c.TailscaleUsers {
		if strings.EqualFold(user, login) {
			return true
		}
	}
	return false
}

func hashPassword(password string) (*Hash, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, defaultIterations, 32)
	if err != nil {
		return nil, err
	}
	return &Hash{Salt: base64.StdEncoding.EncodeToString(salt), Key: base64.StdEncoding.EncodeToString(key), Iterations: defaultIterations}, nil
}

func (h *Hash) valid() bool {
	if h == nil || h.Iterations < 1000 || h.Iterations > 1000000 || len(h.Salt) != 24 || len(h.Key) != 44 {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(h.Salt)
	if err != nil || len(salt) != 16 {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(h.Key)
	return err == nil && len(want) == 32
}

func (h *Hash) verify(password string) bool {
	if !h.valid() || len(password) > 256 {
		return false
	}
	salt, _ := base64.StdEncoding.DecodeString(h.Salt)
	want, _ := base64.StdEncoding.DecodeString(h.Key)
	key, err := pbkdf2.Key(sha256.New, password, salt, h.Iterations, 32)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(key, want) == 1
}

// publicConfig 是给网页看的设置：不含密码派生值。
func publicConfig(c Config) map[string]any {
	return map[string]any{
		"enabled": c.Enabled, "port": c.Port, "lan": c.LAN, "allow_cidrs": c.AllowCIDRs,
		"require_password": c.RequirePassword, "tailscale": c.Tailscale,
		"tailscale_no_password": c.TailscaleNoPassword, "tailscale_users": c.TailscaleUsers,
		"session_hours": c.SessionHours, "has_password": c.Password != nil,
		"enhanced": c.Enhanced.public(), "public_access": c.publicAccess(),
	}
}
