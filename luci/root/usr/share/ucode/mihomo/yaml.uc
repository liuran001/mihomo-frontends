'use strict';

import * as fs from 'fs';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';

const MODES = ['rule', 'global', 'direct'];
const REST_EXPR = 'explode(.) | del(.mode) | del(.["log-level"])';
const RUNTIME_EXPR = '{"mode": .mode, "log-level": .["log-level"]}';
const CONTROLLER_EXPR = '{"ec": .["external-controller"], "secret": .secret, "ui": .["external-ui"], "ui_name": .["external-ui-name"]}';
// 内核重载配置（PUT /configs）时不会重建的部分：控制器的地址、密钥、面板、TLS 证书、CORS、DoH。这些变了只能重启
const HUB_EXPR = 'explode(.) | {"ec": .["external-controller"], "tls": .["external-controller-tls"], "unix": .["external-controller-unix"], ' +
	'"pipe": .["external-controller-pipe"], "cors": .["external-controller-cors"], "doh": .["external-doh-server"], "secret": .secret, ' +
	'"ui": .["external-ui"], "ui_name": .["external-ui-name"], "ui_url": .["external-ui-url"], "cert": .tls}';
const EBPF_EXPR = '[(.listeners // [])[] | select(.type == "ebpf")] | length';
// 让展开合并键的结果符合 YAML 规范（显式键优先），与 mihomo（go-yaml）一致；也关掉 yq 每次打印的提示
const YQ_FLAGS = '--yaml-fix-merge-anchor-to-spec=true';

function yq(args) {
	return sprintf('%s %s %s', U.shq(P.YQ), YQ_FLAGS, args);
}

function available() {
	return !!fs.access(P.YQ, 'x');
}

// 用固定表达式把 YAML 转成 JSON。expr 只能是本模块里的常量。
function query(file, expr) {
	if (!available())
		return null;
	let r = U.run(yq(sprintf('-o=json -I=0 %s %s', U.shq(expr), U.shq(file))), { stderr: false });
	if (r.code != 0)
		return null;
	try {
		return json(r.out);
	} catch (e) {
		return null;
	}
}

// 只检查 YAML 语法（不跑 mihomo -t），编辑器输入停顿后调用。返回 null 表示没有 yq。
function syntax(file) {
	if (!available())
		return null;
	let r = U.run('{ ' + yq(sprintf('-o=json %s', U.shq(file))) + ' 2>&1 >/dev/null; }');
	if (r.code == 0)
		return { valid: true };
	let msg = trim(r.out);
	msg = replace(msg, /^Error: (bad file '[^']*': )?/, '');
	msg = replace(msg, /^(yaml|go-yaml load error in parser|go-yaml load error)[: ]+/, '');
	// 新版 yq：「at L1.C1-L4.C2: …」，出错位置是区间的末尾；旧版：「line 4: …」
	let m = match(msg, /L[0-9]+\.C[0-9]+-L([0-9]+)\.C[0-9]+/) ?? match(msg, /L([0-9]+)\.C[0-9]+/) ?? match(msg, /line ([0-9]+)/);
	return { valid: false, error: msg, line: m ? int(m[1]) : null };
}

// 没有 yq 或文件有语法错误时的退路：读取顶层标量。
function top_scalar(text, key) {
	let re = regexp('^' + key + ':[ \t]*(.*)$');
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, re);
		if (!m)
			continue;
		let v = trim(replace(m[1], /[ \t]+#.*$/, ''));
		let q = match(v, /^'(.*)'$/) ?? match(v, /^"(.*)"$/);
		return q ? q[1] : v;
	}
	return null;
}

// external-controller 的写法：0.0.0.0:9090、:9090、127.0.0.1:9090、[::]:9090、[fd00::1]:9090
function parse_listen(s) {
	if (type(s) != 'string' || s == '')
		return null;
	// ucode 用 POSIX 正则，方括号表达式里不能用反斜杠转义，所以 IPv6 主机写成显式字符集
	let m = match(s, /^\[([0-9a-fA-F:.]*)\]:([0-9]+)$/) ?? match(s, /^([^:]*):([0-9]+)$/);
	if (!m)
		return null;
	let port = +m[2];
	if (port < 1 || port > 65535)
		return null;
	let host = m[1];
	let wildcard = (host == '' || host == '0.0.0.0' || host == '::');
	let loopback = (host == 'localhost' || host == '::1' || match(host, /^127\./) != null);
	return { host: wildcard ? null : host, port: port, wildcard: wildcard, loopback: loopback };
}

function local_host(addr) {
	if (addr.wildcard || addr.host == 'localhost')
		return '127.0.0.1';
	return addr.host;
}

function controller_of(file) {
	let v = query(file, CONTROLLER_EXPR);
	if (v == null) {
		let text = fs.readfile(file);
		if (text == null)
			return null;
		v = { ec: top_scalar(text, 'external-controller'), secret: top_scalar(text, 'secret'),
			ui: top_scalar(text, 'external-ui'), ui_name: top_scalar(text, 'external-ui-name') };
	}
	let listen = v.ec != null ? '' + v.ec : null;
	let str = (x) => (x != null && x !== '') ? '' + x : null;
	return { listen: listen, secret: v.secret != null ? '' + v.secret : '', addr: parse_listen(listen), ui: str(v.ui), ui_name: str(v.ui_name) };
}

function norm(v, dflt) {
	return lc('' + (v ?? dflt));
}

// 新旧配置除 mode、log-level 外完全相同时，返回需要在线修改的键（可能为空对象）；否则返回 null，表示需要重启。
function runtime_delta(old_file, new_file) {
	let a = query(old_file, REST_EXPR);
	let b = query(new_file, REST_EXPR);
	if (a == null || b == null || sprintf('%J', a) != sprintf('%J', b))
		return null;
	let ra = query(old_file, RUNTIME_EXPR);
	let rb = query(new_file, RUNTIME_EXPR);
	if (ra == null || rb == null)
		return null;
	let d = {};
	if (norm(ra.mode, 'rule') != norm(rb.mode, 'rule'))
		d.mode = norm(rb.mode, 'rule');
	if (norm(ra['log-level'], 'info') != norm(rb['log-level'], 'info'))
		d['log-level'] = norm(rb['log-level'], 'info');
	return d;
}

// 两份配置里控制器相关的设置是否相同（相同才能热重载）；读不出来时按不同处理
function hub_same(old_file, new_file) {
	let a = query(old_file, HUB_EXPR), b = query(new_file, HUB_EXPR);
	return a != null && b != null && sprintf('%J', a) == sprintf('%J', b);
}

// 配置里 eBPF 入站的个数；读不出来时为 null
function ebpf_count(file) {
	let n = query(file, EBPF_EXPR);
	return type(n) == 'int' ? n : null;
}

/* ---------- 写回：只替换内容有变化的顶层段落 ---------- */

// yq 会重写整个文件（emoji 写成 \U 转义、给某些标量加引号），所以先在副本上执行 yq，
// 再把有变化的顶层键逐段拼回原文，其余行一字不改；拼好后必须与 yq 的结果语义相同，否则退回整份 yq 输出。

// 顶层键所在行返回键名；空行、注释、缩进行返回 null；其他顶格内容（多文档、顶层序列、跨行 flow 等）返回 false
function top_key(line) {
	let c = substr(line, 0, 1);
	if (c == '' || c == ' ' || c == '\t' || c == '#')
		return null;
	let m = match(line, /^([A-Za-z0-9_][A-Za-z0-9_.-]*):( |$)/);
	return m ? m[1] : false;
}

function is_filler(line) {
	return trim(line) == '' || substr(line, 0, 1) == '#';
}

// 每个顶层键的行范围 [start, end)；段末的空行与顶格注释归下一段（通常是下一段的标题注释）。无法识别时返回 null
function sections(lines) {
	let list = [], seen = {};
	for (let i = 0; i < length(lines); i++) {
		let k = top_key(lines[i]);
		if (k === false || (k != null && seen[k]))
			return null;
		if (k != null) {
			seen[k] = true;
			push(list, { key: k, start: i });
		}
	}
	for (let i = 0; i < length(list); i++) {
		let end = (i + 1 < length(list)) ? list[i + 1].start : length(lines);
		while (end > list[i].start + 1 && is_filler(lines[end - 1]))
			end--;
		list[i].end = end;
	}
	return list;
}

function strip_filler(lines) {
	let s = 0, e = length(lines);
	while (s < e && is_filler(lines[s]))
		s++;
	while (e > s && is_filler(lines[e - 1]))
		e--;
	return slice(lines, s, e);
}

// go-yaml 把 BMP 以外的字符（emoji 等）写成 \UXXXXXXXX，这里还原成原字符；\\ 原样保留
function unescape_astral(text) {
	return replace(text, /\\(\\|U[0-9A-Fa-f]{8})/g, (m, g) => {
		if (g == '\\')
			return m;
		let cp = hex(substr(g, 1));
		return (cp >= 0x10000 && cp <= 0x10FFFF) ? uchr(cp) : m;
	});
}

function same_data(a_file, b_file) {
	let a = query(a_file, 'explode(.)'), b = query(b_file, 'explode(.)');
	return a != null && b != null && sprintf('%J', a) == sprintf('%J', b);
}

function append(dst, src) {
	for (let x in src)
		push(dst, x);
}

// 把 full（yq 的完整输出）中有变化的顶层段落拼回 orig 的原文，写到 out；成功返回 true
function splice(orig_file, full_file, out_file) {
	let a = query(orig_file, 'explode(.)'), b = query(full_file, 'explode(.)');
	if (type(a) != 'object' || type(b) != 'object')
		return false;
	let lines = split(fs.readfile(orig_file) ?? '', '\n');
	let secs = sections(lines);
	if (secs == null)
		return false;
	let by = {};
	for (let s in secs)
		by[s.key] = s;

	let rep = {}, added = [];
	for (let k in keys(a))
		if (!(k in b))
			rep[k] = [];
	for (let k in keys(b)) {
		if (k in a && sprintf('%J', a[k]) == sprintf('%J', b[k]))
			continue;
		let r = U.run('MH_KEY=' + U.shq(k) + ' ' + yq(sprintf('%s %s', U.shq('pick([strenv(MH_KEY)])'), U.shq(full_file))), { stderr: false });
		let body = strip_filler(split(unescape_astral(r.out), '\n'));
		if (r.code != 0 || !length(body) || top_key(body[0]) != k)
			return false;
		if (by[k])
			rep[k] = body;
		else
			append(added, body);
	}
	if (!length(keys(rep)) && !length(added))
		return U.write_file(out_file, fs.readfile(orig_file));

	let out = [], i = 0;
	for (let s in secs) {
		if (!(s.key in rep))
			continue;
		append(out, slice(lines, i, s.start));
		append(out, rep[s.key]);
		i = s.end;
	}
	append(out, slice(lines, i));
	if (length(added)) {
		while (length(out) && out[length(out) - 1] == '')
			pop(out);
		append(out, added);
		push(out, '');
	}
	return U.write_file(out_file, join('\n', out)) && same_data(out_file, full_file);
}

/* ---------- 低层编辑 ---------- */

// forms.uc 把每个 patch 操作翻译成低层编辑 {t, p, v}，这里用一条固定的 yq 表达式执行。
// 用户数据写入临时 JSON 文件，由表达式里的 load() 读入，不拼接进命令行或表达式；@DATA@ 是该文件的路径（内部生成）。
// load() 读入的节点带着 JSON 的样式（键值加引号、flow 风格），`... style=""` 把键和值都恢复成普通样式。
// 带合并键（<<: *锚点）的映射不能用路径赋值改继承来的键：yq 会顺着合并键改到锚点本身。
// 这类映射用 merge（+=，浅合并）在条目这一层写显式键，由调用方保证路径上每一级都是显式键。
// del 删除映射键时，键上方的注释移到下一个键上方（没有下一个键时挂到上一个键之后），不随键一起丢掉。
const EDIT_TYPES = ['set', 'merge', 'append', 'del', 'list'];
const EDIT_EXPR = 'load(@DATA@) as $d | ($d.edits[] as $e ireduce (.; ' +
	'. as $doc | ($e.v | ... style="") as $v | ($e.p | length) as $n | ' +
	'if $e.t == "set" then setpath($e.p; $v) ' +
	'elif $e.t == "del" then (($e.p | to_json(0)) as $pj | ($e.p | .[length - 1]) as $k | ' +
		'([.. | select((path | to_json(0)) == $pj) | key | head_comment] | .[0] // "") as $hc | ' +
		'if $hc == "" or ($k | type) != "!!str" then . else (' +
			'[.. | select((path | to_json(0)) == $pj) | parent | keys | .[]] as $ks | ' +
			'([$ks | to_entries | .[] | select(.value == $k) | .key] | .[0]) as $i | ' +
			'($ks | .[$i + 1]) as $next | ($ks | .[$i - 1]) as $prev | ' +
			'if $next != null then ' +
				'([.. | select((path | to_json(0)) == $pj) | parent | .[$next] | key | head_comment] | .[0] // "") as $nc | ' +
				'(.. | select((path | to_json(0)) == $pj) | parent | .[$next] | key) head_comment = ' +
					'(if $nc == "" then $hc else $hc + "\\n" + $nc end) ' +
			'elif $i > 0 then ' +
				'([.. | select((path | to_json(0)) == $pj) | parent | .[$prev] | foot_comment] | .[0] // "") as $fc | ' +
				'(.. | select((path | to_json(0)) == $pj) | parent | .[$prev]) foot_comment = ' +
					'(if $fc == "" then $hc else $fc + "\\n" + $hc end) ' +
			'else . end) end | delpaths([$e.p])) ' +
	'elif $e.t == "merge" and $n == 1 then .[$e.p[0]] += $v ' +
	'elif $e.t == "merge" and $n == 2 then .[$e.p[0]][$e.p[1]] += $v ' +
	'elif $e.t == "merge" and $n == 3 then .[$e.p[0]][$e.p[1]][$e.p[2]] += $v ' +
	'elif $e.t == "append" and $n == 1 then .[$e.p[0]] += [$v] ' +
	'elif $e.t == "append" and $n == 2 then .[$e.p[0]][$e.p[1]] += [$v] ' +
	'elif $e.t == "append" and $n == 3 then .[$e.p[0]][$e.p[1]][$e.p[2]] += [$v] ' +
	'elif $e.t == "list" and $n == 1 then .[$e.p[0]] = [$e.v[] as $it | ' +
		'if $it.k == null then ($it.v | ... style="") ' +
		'else (($doc | .[$e.p[0]][$it.k]) as $old | ' +
			'if $old == null then error("列表下标越界") ' +
			'elif $it.v == null then $old ' +
			'else ($it.v | ... style="" | . head_comment = ($old | head_comment) | . line_comment = ($old | line_comment)) end) ' +
		'end] ' +
	'else error("不支持的编辑") end))';

function check_edit(e) {
	if (type(e) != 'object' || index(EDIT_TYPES, e.t) < 0 || type(e.p) != 'array' || !length(e.p))
		return false;
	for (let k in e.p)
		if (!(type(k) == 'string' || (type(k) == 'int' && k >= 0)))
			return false;
	let n = length(e.p);
	if ((e.t == 'merge' || e.t == 'append') && n > 3)
		return false;
	if (e.t == 'merge' && type(e.v) != 'object')
		return false;
	if (e.t == 'list') {
		if (n != 1 || type(e.v) != 'array')
			return false;
		for (let it in e.v)
			if (type(it) != 'object' || (it.k == null && it.v == null) ||
			    (it.k != null && !(type(it.k) == 'int' && it.k >= 0)) || (it.v != null && type(it.v) != 'string'))
				return false;
	}
	return true;
}

// 在 work（临时副本）上执行低层编辑；成功返回 null，否则返回错误说明
function edit(work, edits) {
	if (!available())
		return '缺少 yq，无法修改配置';
	if (type(edits) != 'array')
		return '编辑列表无效';
	if (!length(edits))
		return null;
	for (let e in edits)
		if (!check_edit(e))
			return '编辑列表无效';
	U.mkdir_p(P.RUN_DIR);
	let dpath = P.RUN_DIR + '/edit-' + U.rand_hex(4) + '.json';
	if (!U.write_json(dpath, { edits: edits }))
		return '无法写入临时文件';
	let expr = replace(EDIT_EXPR, '@DATA@', sprintf('%J', dpath));
	let r = U.run(yq(sprintf('-i %s %s', U.shq(expr), U.shq(work))));
	fs.unlink(dpath);
	return (r.code == 0) ? null : '修改配置失败：' + trim(replace(r.out, /^Error: /, ''));
}

// 把 work 中有变化的顶层段落拼回 file 的原文，写回 file；成功返回 null
function commit(file, work) {
	U.mkdir_p(P.RUN_DIR);
	let out = P.RUN_DIR + '/ops-' + U.rand_hex(4) + '.out.yaml';
	if (!splice(file, work, out)) {
		// 原文结构无法逐段拼接：使用整份 yq 输出，只把 emoji 转义还原
		if (!(U.write_file(out, unescape_astral(fs.readfile(work))) && same_data(out, work)))
			U.write_file(out, fs.readfile(work));
	}
	// 临时文件在 tmpfs 上，file 在 /etc/mihomo 所在的分区，不能直接 rename（跨文件系统）
	let result = fs.readfile(out);
	fs.unlink(out);
	return (result != null && U.write_file(file, result)) ? null : '无法写回候选配置';
}

export { MODES, available, query, syntax, top_scalar, parse_listen, local_host, controller_of, runtime_delta, hub_same, ebpf_count,
	sections, unescape_astral, edit, commit };
