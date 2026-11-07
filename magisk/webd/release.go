package main

// GitHub release 解析，供 scripts/substore.sh 使用（输出纯文本）：
//   tag REPO                最新正式版的 tag；查不到时输出空行（调用方按 latest 处理）
//   node REPO ARCH MAJOR    node-android-ARCH-MAJOR 这个 release 里版本号最大的 node-android-ARCH-x.y.z.tar.xz 的下载地址

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

func releaseCommand(env toolEnv, args []string) (string, error) {
	if len(args) >= 2 && !repoPattern.MatchString(args[1]) {
		return "", errors.New("仓库名无效")
	}
	switch {
	case len(args) == 2 && args[0] == "tag":
		data, err := fetchBytes(30, withMirror(env.mirror(), "https://api.github.com/repos/"+args[1]+"/releases/latest")...)
		if err != nil {
			return "", nil
		}
		release, err := parseRelease(data)
		if err != nil {
			return "", nil
		}
		return release.TagName, nil
	case len(args) == 4 && args[0] == "node":
		arch, major := args[2], args[3]
		if !regexp.MustCompile(`^[a-z0-9]+$`).MatchString(arch) || !regexp.MustCompile(`^[0-9]+$`).MatchString(major) {
			return "", errors.New("参数无效")
		}
		tag := "node-android-" + arch + "-" + major
		data, err := fetchBytes(30, withMirror(env.mirror(), "https://api.github.com/repos/"+args[1]+"/releases/tags/"+tag)...)
		if err != nil {
			return "", errors.New("无法获取 node 版本列表（GitHub API 不可达，可在「内核版本」里设置下载镜像）")
		}
		release, err := parseRelease(data)
		if err != nil {
			return "", errors.New("node 版本列表格式不对")
		}
		if address := newestNode(release, arch); address != "" {
			return address, nil
		}
		return "", fmt.Errorf("没有找到 %s 架构的 node %s 构建", arch, major)
	}
	return "", errors.New("用法: mihomo-webd release tag REPO|node REPO ARCH MAJOR")
}

// newestNode 在资源里找 node-android-ARCH-x.y.z.tar.xz，取版本号最大的
func newestNode(release githubRelease, arch string) string {
	pattern := regexp.MustCompile(`^https://\S*/node-android-` + regexp.QuoteMeta(arch) + `-([0-9]+(?:\.[0-9]+)*)\.tar\.xz$`)
	best, bestVersion := "", []int(nil)
	for _, asset := range release.Assets {
		match := pattern.FindStringSubmatch(asset.URL)
		if match == nil {
			continue
		}
		version := []int{}
		for _, part := range strings.Split(match[1], ".") {
			number, _ := strconv.Atoi(part)
			version = append(version, number)
		}
		if best == "" || compareVersions(version, bestVersion) > 0 {
			best, bestVersion = asset.URL, version
		}
	}
	return best
}

func compareVersions(a, b []int) int {
	for index := 0; index < len(a) || index < len(b); index++ {
		x, y := 0, 0
		if index < len(a) {
			x = a[index]
		}
		if index < len(b) {
			y = b[index]
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}
