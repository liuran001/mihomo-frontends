package main

// 本机连通性检测与出口 IP 查询（scripts/host.sh 的 netcheck、exitip 转发到这里）。
// 本机经内核代理访问外网：优先 mixed-port，其次 port（HTTP）；都没有时直连（由透明代理接管）。
// 请求交给 curl 并行发出，总耗时约等于最慢的一个。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type netSite struct {
	name, url string
}

var netSites = []netSite{
	{"百度", "https://www.baidu.com/favicon.ico"},
	{"Google", "https://www.gstatic.com/generate_204"},
	{"GitHub", "https://github.githubassets.com/favicon.ico"},
	{"YouTube", "https://www.youtube.com/favicon.ico"},
}

var (
	mixedPortLine = regexp.MustCompile(`(?m)^mixed-port:[ \t]*["']?([0-9]+)`)
	httpPortLine  = regexp.MustCompile(`(?m)^port:[ \t]*["']?([0-9]+)`)
)

// proxyPort 从配置文本里取 mixed-port，没有时取 port；都没有返回 0
func proxyPort(config string) int {
	for _, pattern := range []*regexp.Regexp{mixedPortLine, httpPortLine} {
		if match := pattern.FindStringSubmatch(config); match != nil {
			if port, err := strconv.Atoi(match[1]); err == nil && port > 0 && port < 65536 {
				return port
			}
		}
	}
	return 0
}

// curlRoute 返回 curl 的代理参数与线路名
func curlRoute(env toolEnv) ([]string, string) {
	config, _ := os.ReadFile(env.config())
	if port := proxyPort(string(config)); port > 0 {
		return []string{"--proxy", fmt.Sprintf("http://127.0.0.1:%d", port)}, "proxy"
	}
	return []string{"--noproxy", "*"}, "direct"
}

// curlRun 运行 curl 并返回标准输出（测试可替换）
var curlRun = func(timeout time.Duration, args ...string) string {
	curl, err := curlPath()
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, _ := exec.CommandContext(ctx, curl, args...).Output()
	return string(out)
}

// siteMillis 把 curl -w '%{http_code} %{time_total}' 的输出换算成毫秒；失败为 0
func siteMillis(output string) int {
	parts := strings.Fields(output)
	if len(parts) < 2 || parts[0] == "000" {
		return 0
	}
	seconds, err := strconv.ParseFloat(parts[1], 64)
	if err != nil {
		return 0
	}
	if ms := int(seconds * 1000); ms >= 1 {
		return ms
	}
	return 1
}

func netCommand(env toolEnv, args []string) (obj, error) {
	if len(args) != 1 || (args[0] != "netcheck" && args[0] != "exitip") {
		return nil, errors.New("用法: host.sh netcheck|exitip")
	}
	if _, err := curlPath(); err != nil {
		return nil, errors.New("缺少 curl，无法检测")
	}
	route, via := curlRoute(env)
	if args[0] == "netcheck" {
		results := make([]int, len(netSites))
		var group sync.WaitGroup
		for index, site := range netSites {
			group.Add(1)
			go func() {
				defer group.Done()
				arguments := append([]string{"--disable", "-s", "-o", "/dev/null", "-m", "6", "--connect-timeout", "5"}, route...)
				arguments = append(arguments, "-w", "%{http_code} %{time_total}", "--", site.url)
				results[index] = siteMillis(curlRun(10*time.Second, arguments...))
			}()
		}
		group.Wait()
		sites := make([]obj, len(netSites))
		for index, site := range netSites {
			sites[index] = obj{{"name", site.name}, {"ms", results[index]}}
		}
		return okObj(field{"via", via}, field{"sites", sites}), nil
	}
	services := []string{"https://myip.ipip.net/json", "https://ipwho.is/"}
	bodies := make([]string, len(services))
	var group sync.WaitGroup
	for index, address := range services {
		group.Add(1)
		go func() {
			defer group.Done()
			arguments := append([]string{"--disable", "-s", "-m", "8", "--connect-timeout", "5", "--max-filesize", "65536"}, route...)
			body := curlRun(12*time.Second, append(arguments, "--", address)...)
			bodies[index] = strings.NewReplacer("\r", "", "\n", "").Replace(body)
		}()
	}
	group.Wait()
	return okObj(field{"via", via}, field{"cn", bodies[0]}, field{"intl", bodies[1]}), nil
}
