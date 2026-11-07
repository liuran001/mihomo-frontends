# luci-app-mihomo-ebpf 开发说明

使用说明见仓库根目录的 README，这里只讲怎么构建、测试和调试。

## 打包

在 Linux 或 WSL 里运行：

```sh
sh scripts/setup-apk-tools.sh   # 第一次需要，编译 apk-tools 3
sh scripts/build-apk.sh         # 输出 dist/*.apk
sh scripts/build-ipk.sh         # 输出 dist/*.ipk
```

版本号从 `Makefile` 读取。包没有签名，路由器上安装要加 `--allow-untrusted`：

```sh
apk add --allow-untrusted /tmp/luci-app-mihomo-ebpf-*.apk
```

## 测试

```sh
node tests/frontend/run.js                      # 前端测试，电脑上直接跑
sh tests/run-local.sh                           # 后端测试，在 WSL 里跑，不需要路由器
sh tests/package/install-test.sh dist/xxx.apk   # 在临时目录里装一遍包再卸载
./tests/run-backend.sh                          # 后端测试，在路由器上跑（另起一个 mihomo，不影响正在用的）
```

## 调试

`./deploy.sh root@路由器` 把 `root/` 下的文件直接拷到路由器上。只用于开发，装过软件包的路由器别用，否则文件和包记录对不上。

本地预览页面（不用登录 LuCI，改完文件刷新即可）：

```sh
SSH=ssh ROUTER=root@192.168.77.1 node tests/preview/server.js   # 连真路由器，默认只读，http://localhost:8377/
MIHOMO_PREVIEW_MOCK=1 node tests/preview/server.js              # 不连路由器，用假数据
```

用假数据前要准备两样东西：在 WSL 里跑一次 `sh tests/preview/snapshot.sh` 生成样例数据；把固件包里的 `www/luci-static` 解压到 `tests/preview/.cache/www`。页面地址加 `?fresh=1` 可以模拟全新安装。
