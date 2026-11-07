package main

// 内核下载 / 信息 / 更新 / 回滚（scripts/core.sh 转发到这里）。

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const defaultCoreRepo = "liuran001/mihomo"

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type githubRelease struct {
	TagName string         `json:"tag_name"`
	Assets  []releaseAsset `json:"assets"`
}

// cpuABI 读系统的主 ABI（测试可替换）
var cpuABI = func() string {
	line, _ := firstLine(5*time.Second, "getprop", "ro.product.cpu.abi")
	return strings.TrimSpace(line)
}

// assetFor 按系统主 ABI 选内核：64 位内核上跑 32 位系统时 uname -m 仍是 aarch64，不能只看机器架构。
// 读不到 ABI 时按本程序的架构选（customize.sh 按系统 ABI 装了对应的 mihomo-webd）。
func assetFor(abi, goarch string) (string, bool) {
	switch abi {
	case "arm64-v8a":
		return "android-arm64", true
	case "armeabi-v7a", "armeabi":
		return "android-armv7", true
	case "x86_64":
		return "android-amd64", true
	}
	switch goarch {
	case "arm64":
		return "android-arm64", true
	case "arm":
		return "android-armv7", true
	case "amd64":
		return "android-amd64", true
	}
	return "", false
}

var skippedAsset = regexp.MustCompile(`\.(sha256|txt|zip|xz|deb|rpm|apk)$`)

func selectAsset(release githubRelease, asset string) string {
	pattern := regexp.MustCompile("/mihomo-" + regexp.QuoteMeta(asset) + `(-[^/]*)?(\.gz)?$`)
	for _, item := range release.Assets {
		if pattern.MatchString(item.URL) && !skippedAsset.MatchString(item.URL) {
			return item.URL
		}
	}
	return ""
}

// releaseVersion 从资源文件名取版本：mihomo-android-arm64-v8-alpha-smart-0cc66a1-ebpf.gz → alpha-smart-0cc66a1-ebpf
func releaseVersion(address, asset string) string {
	name := address[strings.LastIndex(address, "/")+1:]
	name = strings.TrimSuffix(name, ".gz")
	name = strings.TrimPrefix(name, "mihomo-"+asset)
	name = strings.TrimPrefix(name, "-v8")
	return strings.TrimPrefix(name, "-")
}

// parseRelease 接受单个 release 或 release 列表（取第一个）
func parseRelease(data []byte) (githubRelease, error) {
	var release githubRelease
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "[") {
		var list []githubRelease
		if err := json.Unmarshal(data, &list); err != nil || len(list) == 0 {
			return release, errors.New("release 信息格式不对")
		}
		return list[0], nil
	}
	if err := json.Unmarshal(data, &release); err != nil {
		return release, errors.New("release 信息格式不对")
	}
	return release, nil
}

// fetchRelease 查 release：指定了 tag 时只查这个 tag；否则查 latest，没有正式版时退回最新的一个（含预发布）
func fetchRelease(repo, tag, mirror string) (githubRelease, error) {
	base := "https://api.github.com/repos/" + repo + "/releases"
	if tag != "" {
		data, err := fetchBytes(30, withMirror(mirror, base+"/tags/"+url.PathEscape(tag))...)
		if err != nil {
			return githubRelease{}, err
		}
		return parseRelease(data)
	}
	if data, err := fetchBytes(30, withMirror(mirror, base+"/latest")...); err == nil {
		if release, err := parseRelease(data); err == nil {
			return release, nil
		}
	}
	data, err := fetchBytes(30, withMirror(mirror, base+"?per_page=1")...)
	if err != nil {
		return githubRelease{}, err
	}
	return parseRelease(data)
}

var metaVersion = regexp.MustCompile(`Mihomo Meta (\S*)`)

// coreVersion 取 mihomo -v 第一行里的版本号；格式不认识时原样返回第一行
func coreVersion(path string) string {
	if !isExecutable(path) {
		return ""
	}
	line, _ := firstLine(10*time.Second, path, "-v")
	if match := metaVersion.FindStringSubmatch(line); match != nil {
		return match[1]
	}
	return line
}

// androidCore 要求是能运行的 Android 内核（Linux 版内核不支持按包名绕过）
func androidCore(path string) bool {
	out, err := combinedOutput(10*time.Second, path, "-v")
	return err == nil && strings.Contains(string(out), " android ")
}

type coreRelease struct {
	tag, url, version string
}

func resolveCoreRelease(env toolEnv) (coreRelease, error) {
	if _, err := curlPath(); err != nil {
		return coreRelease{}, errors.New("缺少 curl，请安装提供 curl 的模块后重试")
	}
	asset, ok := assetFor(cpuABI(), runtime.GOARCH)
	if !ok {
		return coreRelease{}, errors.New("不支持的架构")
	}
	release, err := fetchRelease(env.setting("core_repo", defaultCoreRepo), env.setting("core_tag", ""), env.mirror())
	if err != nil {
		return coreRelease{}, errors.New("获取 release 信息失败")
	}
	address := selectAsset(release, asset)
	if address == "" {
		return coreRelease{}, fmt.Errorf("release %s 中没有 %s 架构的内核", release.TagName, asset)
	}
	return coreRelease{tag: release.TagName, url: address, version: releaseVersion(address, asset)}, nil
}

func coreCommand(env toolEnv, args []string) (obj, error) {
	if len(args) == 0 {
		return nil, errors.New("用法: core.sh check|download|info|rollback|settings|get_settings")
	}
	switch args[0] {
	case "check":
		return coreCheck(env)
	case "download":
		return coreDownload(env, len(args) > 1 && args[1] == "force")
	case "info":
		return coreInfo(env), nil
	case "rollback":
		return coreRollback(env)
	case "settings":
		if len(args) != 4 {
			return nil, errors.New("下载设置格式无效")
		}
		return coreSettings(env, args[1], args[2], args[3])
	case "get_settings":
		return okObj(field{"repo", env.setting("core_repo", defaultCoreRepo)}, field{"tag", env.setting("core_tag", "")},
			field{"mirror", env.mirror()}), nil
	}
	return nil, errors.New("用法: core.sh check|download|info|rollback|settings|get_settings")
}

// coreCheck 只查版本，不下载
func coreCheck(env toolEnv) (obj, error) {
	release, err := resolveCoreRelease(env)
	if err != nil {
		return nil, err
	}
	current := coreVersion(env.bin())
	update := current == "" || current != release.version
	return okObj(field{"latest", release.version}, field{"tag", release.tag}, field{"current", current},
		field{"update_available", update}), nil
}

// coreDownload 下载并替换内核；force 时即使版本相同也重新下载
func coreDownload(env toolEnv, force bool) (obj, error) {
	release, err := resolveCoreRelease(env)
	if err != nil {
		return nil, err
	}
	current := coreVersion(env.bin())
	if !force && release.version != "" && current == release.version {
		return okObj(field{"unchanged", true}, field{"version", current}, field{"tag", release.tag}), nil
	}
	if err := env.ensureDirs(); err != nil {
		return nil, errors.New("无法创建数据目录")
	}
	temp, err := os.CreateTemp(env.runDir(), "mihomo.")
	if err != nil {
		return nil, errors.New("无法创建临时文件")
	}
	temp.Close()
	tmp := temp.Name()
	defer os.Remove(tmp)
	if err := downloadFile(600, tmp, withMirror(env.mirror(), release.url)...); err != nil {
		return nil, errors.New("下载失败")
	}
	if strings.HasSuffix(release.url, ".gz") {
		if err := gunzipInPlace(tmp); err != nil {
			return nil, errors.New("解压失败")
		}
	}
	if err := os.Chmod(tmp, 0o755); err != nil || !androidCore(tmp) {
		return nil, errors.New("需要可运行的 Android 内核；Linux 内核不支持 Android 包名绕过")
	}
	unlock, err := env.lockBackend()
	if err != nil {
		return nil, errors.New("后台忙，未替换内核")
	}
	defer unlock()
	if info, err := os.Stat(env.bin()); err == nil && info.Mode().IsRegular() {
		if err := copyFile(env.bin(), env.binPrev()+".tmp", 0o755); err != nil || os.Rename(env.binPrev()+".tmp", env.binPrev()) != nil {
			os.Remove(env.binPrev() + ".tmp")
			return nil, errors.New("备份旧内核失败")
		}
	}
	if err := os.Rename(tmp, env.bin()); err != nil {
		return nil, errors.New("安装内核失败")
	}
	return okObj(field{"version", coreVersion(env.bin())}, field{"tag", release.tag}), nil
}

func coreInfo(env toolEnv) obj {
	if !isExecutable(env.bin()) {
		return okObj(field{"installed", false})
	}
	line, _ := firstLine(10*time.Second, env.bin(), "-v")
	rollback := ""
	if info, err := os.Stat(env.binPrev()); err == nil && info.Mode().IsRegular() {
		rollback = "yes"
	}
	return okObj(field{"installed", true}, field{"version", line}, field{"can_rollback", rollback})
}

func coreRollback(env toolEnv) (obj, error) {
	unlock, err := env.lockBackend()
	if err != nil {
		return nil, errors.New("后台忙")
	}
	defer unlock()
	if info, err := os.Stat(env.binPrev()); err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("没有可回滚的旧版本")
	}
	if !androidCore(env.binPrev()) {
		return nil, errors.New("旧版本不是可运行的 Android 内核，不能回滚")
	}
	// 当前与旧版本对调：当前版本成为新的「旧版本」，可以再回滚回来
	swap := env.binPrev() + ".tmp"
	if copyFile(env.bin(), swap, 0o755) != nil || os.Rename(env.binPrev(), env.bin()) != nil || os.Rename(swap, env.binPrev()) != nil {
		os.Remove(swap)
		return nil, errors.New("内核回滚失败，请检查可用空间和文件权限")
	}
	_ = os.Chmod(env.bin(), 0o755)
	return okObj(), nil
}

var repoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// coreSettings 保存下载设置；空字符串由调用方用 - 占位传入
func coreSettings(env toolEnv, repo, tag, mirror string) (obj, error) {
	if repo == "-" {
		repo = defaultCoreRepo
	}
	if tag == "-" {
		tag = ""
	}
	if mirror == "-" {
		mirror = ""
	}
	if !repoPattern.MatchString(repo) || hasControl(repo+tag+mirror) {
		return nil, errors.New("下载设置格式无效")
	}
	if mirror != "" && !strings.HasPrefix(mirror, "https://") && !strings.HasPrefix(mirror, "http://") {
		return nil, errors.New("镜像地址必须使用 http:// 或 https://")
	}
	unlock, err := env.lockBackend()
	if err != nil {
		return nil, errors.New("后台忙")
	}
	defer unlock()
	if err := settingsPut(env.settings(), env.runDir(), [2]string{"core_repo", repo}, [2]string{"core_tag", tag},
		[2]string{"core_mirror", mirror}); err != nil {
		return nil, errors.New("保存下载设置失败")
	}
	return okObj(), nil
}

func gunzipInPlace(path string) error {
	source, err := os.Open(path)
	if err != nil {
		return err
	}
	defer source.Close()
	reader, err := gzip.NewReader(source)
	if err != nil {
		return err
	}
	target, err := os.CreateTemp(filepath.Dir(path), "gunzip.")
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(target, reader)
	closeErr := target.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil {
		copyErr = os.Rename(target.Name(), path)
	}
	if copyErr != nil {
		os.Remove(target.Name())
	}
	return copyErr
}

func copyFile(source, target string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	return copyErr
}
