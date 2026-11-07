package main

// 模块自身的检查更新与一键升级（scripts/module-update.sh 转发到这里）。
//   check    读取最新 release 的 update.json，与本模块的 versionCode 比较
//   upgrade  下载新版本 zip、校验 sha256，交给 root 管理器（KernelSU / APatch / Magisk）安装；
//            customize.sh 随后在后台把新版本直接换上（见 live-update.sh），不需要重启

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	moduleRepo     = "liuran001/mihomo-frontends"
	manifestURL    = "https://github.com/" + moduleRepo + "/releases/latest/download/update.json"
	downloadPrefix = "https://github.com/" + moduleRepo + "/releases/download/"
)

// adbDir 是 root 管理器的目录（测试可替换）
var adbDir = "/data/adb"

type moduleManifest struct {
	version   string
	code      uint64
	zipURL    string
	zipSha256 string
	changelog string
}

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// parseManifest 只接受本仓库 release 里的 zip，校验值必须是 64 位十六进制
func parseManifest(data []byte) (moduleManifest, error) {
	var raw struct {
		Version     string          `json:"version"`
		VersionCode json.RawMessage `json:"versionCode"`
		ZipURL      string          `json:"zipUrl"`
		ZipSha256   string          `json:"zipSha256"`
		Changelog   string          `json:"changelog"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return moduleManifest{}, errors.New("更新信息格式不对")
	}
	code, err := strconv.ParseUint(strings.Trim(string(raw.VersionCode), `"`), 10, 64)
	if err != nil {
		return moduleManifest{}, errors.New("更新信息格式不对")
	}
	if !strings.HasPrefix(raw.ZipURL, downloadPrefix) || !strings.HasSuffix(raw.ZipURL, ".zip") {
		return moduleManifest{}, errors.New("更新信息里的下载地址不是本项目的 release")
	}
	if strings.Contains(raw.ZipURL, "..") || strings.ContainsAny(raw.ZipURL, " \t\r\n") {
		return moduleManifest{}, errors.New("更新信息里的下载地址无效")
	}
	if !sha256Pattern.MatchString(raw.ZipSha256) {
		return moduleManifest{}, errors.New("更新信息缺少有效的 sha256")
	}
	return moduleManifest{version: raw.Version, code: code, zipURL: raw.ZipURL, zipSha256: raw.ZipSha256, changelog: raw.Changelog}, nil
}

func (e toolEnv) moduleProp(key string) string {
	return settingGet(filepath.Join(e.moddir, "module.prop"), key, "")
}

func (e toolEnv) moduleCode() uint64 {
	code, err := strconv.ParseUint(e.moduleProp("versionCode"), 10, 64)
	if err != nil {
		return 0
	}
	return code
}

// 先走下载镜像（与内核下载同一设置），失败再直连
func readManifest(env toolEnv) (moduleManifest, error) {
	if _, err := curlPath(); err != nil {
		return moduleManifest{}, errors.New("缺少 curl，无法检查更新")
	}
	if err := env.ensureDirs(); err != nil {
		return moduleManifest{}, errors.New("无法创建运行目录")
	}
	data, err := fetchBytes(30, withMirror(env.mirror(), manifestURL)...)
	if err != nil {
		return moduleManifest{}, errors.New("获取更新信息失败，请检查网络或下载镜像")
	}
	return parseManifest(data)
}

// moduleInstaller 按 root 方案选安装命令
func moduleInstaller() ([]string, error) {
	if path := filepath.Join(adbDir, "ksud"); isExecutable(path) {
		return []string{path, "module", "install"}, nil
	}
	if path := filepath.Join(adbDir, "apd"); isExecutable(path) {
		return []string{path, "module", "install"}, nil
	}
	if path, err := exec.LookPath("magisk"); err == nil {
		return []string{path, "--install-module"}, nil
	}
	return nil, errors.New("没有找到 KernelSU、APatch 或 Magisk 的安装命令")
}

func moduleCommand(env toolEnv, args []string) (obj, error) {
	action := ""
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "check":
		manifest, err := readManifest(env)
		if err != nil {
			return nil, err
		}
		code := env.moduleCode()
		return okObj(field{"current", env.moduleProp("version")}, field{"current_code", code},
			field{"latest", manifest.version}, field{"latest_code", manifest.code},
			field{"update_available", manifest.code > code}, field{"changelog", manifest.changelog}), nil
	case "upgrade":
		return moduleUpgrade(env, len(args) > 1 && args[1] == "force")
	case "current":
		return okObj(field{"current", env.moduleProp("version")}, field{"current_code", env.moduleCode()}), nil
	}
	return nil, errors.New("用法: module-update.sh check|upgrade [force]|current")
}

func moduleUpgrade(env toolEnv, force bool) (obj, error) {
	manifest, err := readManifest(env)
	if err != nil {
		return nil, err
	}
	if manifest.code <= env.moduleCode() && !force {
		return okObj(field{"unchanged", true}, field{"version", env.moduleProp("version")}), nil
	}
	installer, err := moduleInstaller()
	if err != nil {
		return nil, err
	}
	zip := filepath.Join(env.runDir(), "module-update.zip")
	os.Remove(zip)
	defer os.Remove(zip)
	if err := downloadFile(600, zip, withMirror(env.mirror(), manifest.zipURL)...); err != nil {
		return nil, errors.New("下载新版本失败，请检查网络或下载镜像")
	}
	if sum, err := fileSha256(zip); err != nil || sum != manifest.zipSha256 {
		return nil, errors.New("新版本校验失败（sha256 不符），已放弃安装")
	}
	// 安装器输出写日志；customize.sh 会在后台换上新版本
	logPath := filepath.Join(env.runDir(), "module-update.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, errors.New("无法写入安装日志")
	}
	command := exec.Command(installer[0], append(installer[1:], zip)...)
	command.Stdout, command.Stderr = logFile, logFile
	runErr := command.Run()
	logFile.Close()
	output, _ := os.ReadFile(logPath)
	if runErr != nil {
		return nil, errors.New("安装失败：" + lastLines(string(output), 3))
	}
	return okObj(field{"version", manifest.version}, field{"live", bytes.Contains(output, []byte("立即生效"))}), nil
}

func fileSha256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// lastLines 取最后 n 行，用空格连成一行
func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " ")
}
