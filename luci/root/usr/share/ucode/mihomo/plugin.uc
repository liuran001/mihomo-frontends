'use strict';

// LuCI 插件自身的检查更新与一键升级。
// 版本信息来自本项目最新 release 的 update.json（与 Magisk 模块共用）；按本机的包管理器选 apk 或 ipk，
// 下载、校验 sha256 后在后台进程里安装（安装会让 rpcd 重新加载，不能在 rpc 调用里同步进行）。
import * as fs from 'fs';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as CORE from 'mihomo.core';

const REPO = 'liuran001/mihomo-frontends';
const MANIFEST = P.PLUGIN_MANIFEST ?? sprintf('https://github.com/%s/releases/latest/download/update.json', REPO);
const PKG_PREFIX = P.PLUGIN_BASE ?? sprintf('https://github.com/%s/releases/download/', REPO);
const VERSION_RE = /^V([0-9]+)\.([0-9]+)\.([0-9]+)-([0-9]{1,12})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const STATUS = P.RUN_DIR + '/plugin-upgrade.json';

// "V1.0.0-26110701" → 构建号 26110701；格式不对时为 null
function code_of(v) {
	let m = match(type(v) == 'string' ? trim(v) : '', VERSION_RE);
	return m ? +m[4] : null;
}

function installed() {
	let v = trim(fs.readfile(P.PLUGIN_VERSION) ?? '');
	return { version: v != '' ? v : null, code: code_of(v) };
}

// 本机用哪种包：OpenWrt 24.10 起是 apk，之前是 opkg
function format() {
	if (fs.access(P.APK, 'x'))
		return 'apk';
	if (fs.access(P.OPKG, 'x'))
		return 'ipk';
	return null;
}

// 解析 update.json，取出本机格式的安装包；地址只接受本项目的 release
function parse_manifest(text, fmt) {
	let m;
	try { m = json(text ?? ''); } catch (e) { m = null; }
	if (type(m) != 'object' || type(m.luci) != 'object')
		return { ok: false, error: '更新信息格式不对' };
	let code = code_of(m.version);
	if (code == null || m.versionCode != code)
		return { ok: false, error: '更新信息里的版本号格式不对' };
	let pkg = m.luci[fmt];
	if (type(pkg) != 'object')
		return { ok: false, error: '更新信息里没有 ' + fmt + ' 安装包' };
	let url = pkg.url, sha = pkg.sha256;
	if (type(url) != 'string' || substr(url, 0, length(PKG_PREFIX)) != PKG_PREFIX || index(url, '..') >= 0 ||
		match(url, /[ \t\n'"\\]/) || !match(url, regexp('\\.' + fmt + '$')))
		return { ok: false, error: '更新信息里的下载地址不是本项目的 release' };
	if (type(sha) != 'string' || !match(sha, SHA_RE))
		return { ok: false, error: '更新信息缺少有效的 sha256' };
	return { ok: true, version: m.version, code: code, url: url, sha256: sha,
		changelog: type(m.changelog) == 'string' ? m.changelog : null };
}

function latest(opts) {
	let fmt = format();
	if (!fmt)
		return { ok: false, error: '没有找到 apk 或 opkg，无法自动升级' };
	U.mkdir_p(P.RUN_DIR);
	let file = P.RUN_DIR + '/plugin-update.json';
	let r = CORE.fetch(MANIFEST, file, { quick: true, routes: opts?.routes });
	if (!r.ok)
		return { ok: false, error: '获取更新信息失败：' + r.error };
	let res = parse_manifest(fs.readfile(file), fmt);
	fs.unlink(file);
	if (res.ok) {
		res.format = fmt;
		res.route = r.label;
	}
	return res;
}

function check(opts) {
	let cur = installed();
	let l = latest(opts);
	if (!l.ok)
		return { ...l, current: cur.version };
	return { ok: true, current: cur.version, latest: l.version, format: l.format, route: l.route, changelog: l.changelog,
		update_available: cur.code == null || l.code > cur.code };
}

// 进程还没写入 pid 时，30 秒内视为正在启动
function job_running(s) {
	if (type(s) != 'object' || s.state != 'running')
		return false;
	if (type(s.pid) == 'int' && s.pid > 0)
		return fs.stat('/proc/' + s.pid) != null;
	return type(s.started) == 'int' && time() - s.started < 30;
}

function status() {
	let s = U.read_json(STATUS);
	if (type(s) == 'object' && s.state == 'running' && !job_running(s))
		s = { ...s, state: 'failed', error: '升级进程意外退出' };
	let cur = installed();
	return { ok: true, current: cur.version, job: type(s) == 'object' ? s : null };
}

// rpc：拉起后台安装进程，立即返回；页面轮询 status
function upgrade(a) {
	if (job_running(U.read_json(STATUS)))
		return { ok: false, error: '升级正在进行中' };
	if (!fs.access(P.PLUGIN_UPGRADER, 'x'))
		return { ok: false, error: '缺少升级程序 ' + P.PLUGIN_UPGRADER };
	U.mkdir_p(P.RUN_DIR);
	U.write_json(STATUS, { state: 'running', step: 'start', force: !!a?.force, started: time() });
	let rc = system(sprintf('(setsid %s %s </dev/null >/dev/null 2>&1 &)', U.shq(P.PLUGIN_UPGRADER), a?.force ? 'force' : 'normal'));
	if (rc != 0) {
		U.write_json(STATUS, { state: 'failed', error: '无法启动升级进程' });
		return { ok: false, error: '无法启动升级进程' };
	}
	return { ok: true };
}

// 后台进程体（plugin-upgrade 调用）
function run_upgrade(force, opts) {
	let st = { state: 'running', step: 'check', pid: +fs.readlink('/proc/self'), started: time() };
	let save = (fields) => { st = { ...st, ...fields }; U.write_json(STATUS, st); return st; };
	save({});
	let cur = installed();
	let l = latest(opts);
	if (!l.ok)
		return save({ state: 'failed', error: l.error });
	if (!force && cur.code != null && l.code <= cur.code)
		return save({ state: 'done', version: cur.version, unchanged: true });

	save({ step: 'download', version: l.version });
	let file = P.RUN_DIR + '/luci-app-mihomo-ebpf.' + l.format;
	let r = CORE.fetch(l.url, file, { max_time: 120, routes: opts?.routes });
	if (!r.ok)
		return save({ state: 'failed', error: '下载安装包失败：' + r.error });
	if (CORE.sha256(file) != l.sha256) {
		fs.unlink(file);
		return save({ state: 'failed', error: '安装包校验失败（sha256 不符），已放弃安装' });
	}

	save({ step: 'install' });
	let cmd = P.PLUGIN_INSTALL ?? (l.format == 'apk'
		? U.shq(P.APK) + ' add --allow-untrusted'
		: U.shq(P.OPKG) + ' install' + (force ? ' --force-reinstall' : ''));
	let res = U.run(cmd + ' ' + U.shq(file));
	fs.unlink(file);
	if (res.code != 0)
		return save({ state: 'failed', error: '安装失败', detail: U.tail_lines(res.out, 8) });
	let now = installed();
	return save({ state: 'done', version: now.version ?? l.version, step: null });
}

export { job_running, code_of, installed, format, parse_manifest, check, status, upgrade, run_upgrade, STATUS };
