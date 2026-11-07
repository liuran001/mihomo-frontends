'use strict';

// 所有路径集中在这里。MIHOMO_LUCI_* 环境变量只给测试用，正式运行时都未设置。
function env(name, dflt) {
	let v = getenv(name);
	return (v != null && v != '') ? v : dflt;
}

const HOME = env('MIHOMO_LUCI_HOME', '/etc/mihomo');
const CONFIG = HOME + '/config.yaml';
const CANDIDATE = HOME + '/config.yaml.new';
const BACKUP_DIR = HOME + '/backup';
const STATE_DIR = HOME + '/.luci';
const DISABLED = STATE_DIR + '/disabled.json';
const BIN = env('MIHOMO_LUCI_BIN', '/usr/bin/mihomo-ebpf');
const INIT = env('MIHOMO_LUCI_INIT', '/etc/init.d/mihomo');
const SERVICE = env('MIHOMO_LUCI_SERVICE', 'mihomo');
const RUN_DIR = env('MIHOMO_LUCI_RUN', '/var/run/mihomo-luci');
const LOCK = RUN_DIR + '/lock';
const JOB_DIR = RUN_DIR + '/jobs';
const YQ = env('MIHOMO_LUCI_YQ', '/usr/bin/yq');
const JOB_BIN = env('MIHOMO_LUCI_JOB', '/usr/libexec/mihomo-luci/apply-job');
const START_TIMEOUT = +env('MIHOMO_LUCI_START_TIMEOUT', '15');
const BACKUP_KEEP = 10;
const LOG_TAG = 'mihomo-ebpf';
const LEASES = env('MIHOMO_LUCI_LEASES', '/tmp/dhcp.leases');
const BIN_PREV = BIN + '.prev';
const TEMPLATE = env('MIHOMO_LUCI_TEMPLATE', '/usr/share/mihomo-luci/template.yaml');
const UCI_DIR = env('MIHOMO_LUCI_UCI_DIR', '/etc/config');
const UCI_CONF = 'mihomo';
const CORE_LATEST = RUN_DIR + '/core-latest.json';
const CURL = env('MIHOMO_LUCI_CURL', '/usr/bin/curl');
// 非空时代替 https://github.com/<repo>/releases/download/<tag>/（测试用本地目录）
const RELEASE_BASE = env('MIHOMO_LUCI_RELEASE_BASE', '');
// Sub-Store：程序与数据目录、procd 服务、后台安装脚本
const SUBSTORE_DIR = env('MIHOMO_LUCI_SUBSTORE_DIR', '/etc/mihomo/substore');
const SUBSTORE_INIT = env('MIHOMO_LUCI_SUBSTORE_INIT', '/etc/init.d/mihomo-substore');
const SUBSTORE_INSTALLER = env('MIHOMO_LUCI_SUBSTORE_INSTALLER', '/usr/libexec/mihomo-luci/substore-install');
const NODE = env('MIHOMO_LUCI_NODE', '/usr/bin/node');
// 插件自身的升级：已安装版本、包管理器、后台安装脚本；后三个 null 的只给测试用（代替 release 地址与安装命令）
const PLUGIN_VERSION = env('MIHOMO_LUCI_VERSION_FILE', '/usr/share/mihomo-luci/version');
const APK = env('MIHOMO_LUCI_APK', '/usr/bin/apk');
const OPKG = env('MIHOMO_LUCI_OPKG', '/bin/opkg');
const PLUGIN_UPGRADER = env('MIHOMO_LUCI_PLUGIN_UPGRADER', '/usr/libexec/mihomo-luci/plugin-upgrade');
const PLUGIN_MANIFEST = env('MIHOMO_LUCI_PLUGIN_MANIFEST', null);
const PLUGIN_BASE = env('MIHOMO_LUCI_PLUGIN_BASE', null);
const PLUGIN_INSTALL = env('MIHOMO_LUCI_PLUGIN_INSTALL', null);

export { HOME, CONFIG, CANDIDATE, BACKUP_DIR, STATE_DIR, DISABLED, BIN, INIT, SERVICE, RUN_DIR, LOCK, JOB_DIR, YQ, JOB_BIN,
	START_TIMEOUT, BACKUP_KEEP, LOG_TAG, LEASES, BIN_PREV, TEMPLATE, UCI_DIR, UCI_CONF, CORE_LATEST, CURL, RELEASE_BASE,
	SUBSTORE_DIR, SUBSTORE_INIT, SUBSTORE_INSTALLER, NODE,
	PLUGIN_VERSION, APK, OPKG, PLUGIN_UPGRADER, PLUGIN_MANIFEST, PLUGIN_BASE, PLUGIN_INSTALL };
