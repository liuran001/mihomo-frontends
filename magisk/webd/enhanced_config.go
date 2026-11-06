package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"unicode/utf8"
)

type EnhancedConfig struct {
	Enabled       bool   `json:"enabled"`
	Password      *Hash  `json:"password,omitempty"`
	Scrcpy        bool   `json:"scrcpy"`
	ScrcpyPort    int    `json:"scrcpy_port"`
	ScrcpyMode    string `json:"scrcpy_mode"`
	ScrcpyMaxSize int    `json:"scrcpy_max_size"`
	ScrcpyFPS     int    `json:"scrcpy_fps"`
	ScrcpyBitRate int    `json:"scrcpy_bit_rate"`
}

func (config *EnhancedConfig) validate(hasPassword, requirePassword bool) error {
	if config.ScrcpyPort == 0 {
		config.ScrcpyPort = 8080
	}
	if config.ScrcpyPort < 1 || config.ScrcpyPort > 65535 {
		return errors.New("web scrcpy 端口须为 1–65535")
	}
	if config.ScrcpyMode == "" {
		config.ScrcpyMode = "builtin"
	}
	if config.ScrcpyMode != "builtin" && config.ScrcpyMode != "external" {
		return errors.New("屏幕服务模式须为 builtin 或 external")
	}
	if config.ScrcpyMaxSize == 0 {
		config.ScrcpyMaxSize = 1280
	}
	if config.ScrcpyFPS == 0 {
		config.ScrcpyFPS = 24
	}
	if config.ScrcpyBitRate == 0 {
		config.ScrcpyBitRate = 2000000
	}
	if config.ScrcpyMaxSize < 640 || config.ScrcpyMaxSize > 1920 || config.ScrcpyFPS < 5 || config.ScrcpyFPS > 60 || config.ScrcpyBitRate < 256000 || config.ScrcpyBitRate > 8000000 {
		return errors.New("屏幕参数超出限制：分辨率 640–1920、帧率 5–60、码率 256000–8000000")
	}
	if config.Enabled && (!hasPassword || !requirePassword) {
		return errors.New("增强功能需要设置主 WebUI 密码并启用密码访问")
	}
	if config.Password != nil && !config.Password.valid() {
		return errors.New("操作密码数据无效")
	}
	return nil
}

func (config EnhancedConfig) public() map[string]any {
	return map[string]any{
		"enabled": config.Enabled, "has_password": config.Password != nil, "scrcpy": config.Scrcpy, "scrcpy_port": config.ScrcpyPort,
		"scrcpy_mode": config.ScrcpyMode, "scrcpy_max_size": config.ScrcpyMaxSize, "scrcpy_fps": config.ScrcpyFPS, "scrcpy_bit_rate": config.ScrcpyBitRate,
	}
}

func (config Config) publicAccess() bool {
	if !config.LAN {
		return false
	}
	trusted := append(append([]netip.Prefix{}, privatePrefixes...), netip.MustParsePrefix("100.64.0.0/10"))
	for _, allowed := range config.prefixes() {
		private := false
		for _, prefix := range trusted {
			if prefix.Contains(allowed.Addr()) && prefix.Bits() <= allowed.Bits() {
				private = true
				break
			}
		}
		if !private {
			return true
		}
	}
	return false
}

func setEnhancedConfig(path, encoded string) error {
	data, err := decodeArg(encoded)
	if err != nil {
		return err
	}
	var patch struct {
		Enabled    *bool   `json:"enabled"`
		Password   *string `json:"password"`
		Scrcpy     *bool   `json:"scrcpy"`
		ScrcpyPort *int    `json:"scrcpy_port"`
		ScrcpyMode *string `json:"scrcpy_mode"`
	}
	if err := decodeStrict(bytes.NewReader(data), &patch); err != nil {
		return err
	}
	return updateConfig(path, func(config *Config) error {
		if patch.Enabled != nil {
			if *patch.Enabled && config.Password == nil {
				return errors.New("请先设置主 WebUI 登录密码")
			}
			config.Enhanced.Enabled = *patch.Enabled
			if *patch.Enabled {
				config.RequirePassword = true
				config.Enabled = true
			} else {
				config.Enhanced.Scrcpy = false
			}
		}
		if patch.Password != nil {
			password := *patch.Password
			if password == "" {
				config.Enhanced.Password = nil
			} else {
				if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 6 || len(password) > 256 || strings.ContainsRune(password, 0) {
					return errors.New("操作密码须为 6–256 个字符")
				}
				config.Enhanced.Password, err = hashPassword(password)
				if err != nil {
					return err
				}
			}
		}
		if patch.Scrcpy != nil {
			config.Enhanced.Scrcpy = *patch.Scrcpy
		}
		if patch.ScrcpyPort != nil {
			config.Enhanced.ScrcpyPort = *patch.ScrcpyPort
		}
		if patch.ScrcpyMode != nil {
			config.Enhanced.ScrcpyMode = *patch.ScrcpyMode
		}
		if config.Enhanced.Scrcpy && !config.Enhanced.Enabled {
			return errors.New("请先在本机启用增强功能")
		}
		if config.Enhanced.Scrcpy && config.Enhanced.ScrcpyPort == config.Port {
			return errors.New("web scrcpy 不能指向 WebUI 自身的端口")
		}
		return nil
	})
}

func enhancedConfigID(config Config) string {
	value, _ := json.Marshal(struct {
		Password          *Hash
		Enabled           bool
		OperationPassword *Hash
		Required          bool
	}{config.Password, config.Enhanced.Enabled, config.Enhanced.Password, config.RequirePassword})
	return string(value)
}
