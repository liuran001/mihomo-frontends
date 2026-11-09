'use strict';

import * as fs from 'fs';
import * as Y from 'mihomo.yaml';
import * as U from 'mihomo.util';
import * as P from 'mihomo.paths';
import { ok, eq, done } from 'lib';

eq(Y.parse_listen('0.0.0.0:9090'), { host: null, port: 9090, wildcard: true, loopback: false }, '通配地址');
eq(Y.parse_listen(':9090').wildcard, true, '省略主机即通配');
eq(Y.parse_listen('[::]:9090').wildcard, true, 'IPv6 通配');
eq(Y.parse_listen('127.0.0.1:9090').loopback, true, '回环地址');
eq(Y.parse_listen('[::1]:9090').loopback, true, 'IPv6 回环');
eq(Y.parse_listen('localhost:9090').loopback, true, 'localhost');
eq(Y.parse_listen('192.168.77.1:9090'), { host: '192.168.77.1', port: 9090, wildcard: false, loopback: false }, '指定地址');
eq(Y.parse_listen('[fd00::1]:9090').host, 'fd00::1', '指定 IPv6 地址');
eq(Y.parse_listen('bad'), null, '非法写法');
eq(Y.parse_listen('1.2.3.4:70000'), null, '端口越界');
eq(Y.parse_listen(null), null, '缺失');

eq(Y.local_host(Y.parse_listen('0.0.0.0:9090')), '127.0.0.1', '通配地址从本机访问 127.0.0.1');
eq(Y.local_host(Y.parse_listen('localhost:9090')), '127.0.0.1', 'localhost 换成 127.0.0.1');
eq(Y.local_host(Y.parse_listen('[fd00::1]:9090')), 'fd00::1', '指定地址原样使用');

eq(Y.top_scalar("a: 1\nsecret: 'x y' # c\n", 'secret'), 'x y', 'top_scalar 去掉引号与注释');
eq(Y.top_scalar('external-controller: "0.0.0.0:9090"\n', 'external-controller'), '0.0.0.0:9090', 'top_scalar 双引号');
eq(Y.top_scalar('  secret: nested\n', 'secret'), null, 'top_scalar 只认顶层');

ok(Y.available(), 'yq 已安装');
eq(Y.query(P.CONFIG, '.mode'), 'rule', 'query 读取标量');

let c = Y.controller_of(P.CONFIG);
eq([c.listen, c.secret, c.addr.port], ['127.0.0.1:19090', 'test-secret', 19090], '从配置读取控制器');
eq([c.ui, c.ui_name], [null, null], '没有 external-ui 时为 null');
eq([c.tls_listen, c.tls_addr], [null, null], '没有 external-controller-tls 时为 null');

let tmp = P.RUN_DIR + '/c2.yaml';
let base = fs.readfile(P.CONFIG);
U.write_file(tmp, base + 'external-controller-tls: 0.0.0.0:19443\n');
let ct = Y.controller_of(tmp);
eq([ct.tls_listen, ct.tls_addr.port, ct.tls_addr.wildcard], ['0.0.0.0:19443', 19443, true], '读取 external-controller-tls');
U.write_file(tmp, base + 'external-controller-tls: "[::]:19443"\n');
eq([Y.controller_of(tmp).tls_addr.host, Y.controller_of(tmp).tls_addr.port], [null, 19443], 'TLS 地址支持 IPv6 通配');
U.write_file(tmp, base + 'external-controller-tls: "bad"\n');
eq([Y.controller_of(tmp).tls_listen, Y.controller_of(tmp).tls_addr], ['bad', null], 'TLS 地址写法无效时为 null');
U.write_file(tmp, replace(base, 'mode: rule', 'mode: global'));
eq(Y.runtime_delta(P.CONFIG, tmp), { mode: 'global' }, '只改 mode 时返回在线修改项');
U.write_file(tmp, replace(base, 'log-level: info', 'log-level: debug') + '# 尾部注释\n');
eq(Y.runtime_delta(P.CONFIG, tmp), { 'log-level': 'debug' }, '注释变化不影响判断');
U.write_file(tmp, base + 'external-ui: ./dashboard\nexternal-ui-name: zash\n');
eq([Y.controller_of(tmp).ui, Y.controller_of(tmp).ui_name], ['./dashboard', 'zash'], '读取 external-ui 与 external-ui-name');
U.write_file(tmp, replace(base, 'mixed-port: 17890', 'mixed-port: 17891'));
eq(Y.runtime_delta(P.CONFIG, tmp), null, '改其他键需要重启');
U.write_file(tmp, base);
eq(Y.runtime_delta(P.CONFIG, tmp), {}, '内容相同返回空对象');
U.write_file(tmp, 'mode: rule\nfoo: [\n');
eq(Y.runtime_delta(P.CONFIG, tmp), null, '无法解析时视为需要重启');

// 低层编辑 + 逐段写回（patch 操作的公共部分）
let mode = (m) => [{ t: 'set', p: ['mode'], v: m }];
function edit_commit(file, edits) {
	let work = P.RUN_DIR + '/w-' + U.rand_hex(4) + '.yaml';
	U.write_file(work, fs.readfile(file));
	let err = Y.edit(work, edits) ?? Y.commit(file, work);
	fs.unlink(work);
	return err;
}

U.write_file(tmp, base);
eq(edit_commit(tmp, mode('direct')), null, 'set 成功');
eq(Y.query(tmp, '.mode'), 'direct', 'set 写入文件');
ok(match(fs.readfile(tmp), /\nmode: direct\n/), 'set 写成普通标量，不带引号');
ok(index(fs.readfile(tmp), '# 测试用最小配置') >= 0, 'set 保留注释');
ok(Y.edit(tmp, [{ t: 'rm', p: ['/'] }]) != null, '拒绝未知编辑类型');

// 逐段写回：其他段落（emoji、flow 写法、注释）一字不改
let rich = "# 头部注释\nmode: rule # 模式\nlog-level: info\n\n# 分组\nproxy-groups:\n  - {name: 香港🇭🇰, type: select, proxies: [DIRECT]}\nebpf:\n  bypass-exclude: [100.64.0.0/10, fd7a:115c:a1e0::/48]\n";
let rich2 = replace(rich, 'mode: rule # 模式', 'mode: global # 模式');
U.write_file(tmp, rich);
eq(edit_commit(tmp, mode('global')), null, '逐段写回成功');
eq(fs.readfile(tmp), rich2, '只改动 mode 这一行');
eq(edit_commit(tmp, mode('global')), null, '值不变时成功');
eq(fs.readfile(tmp), rich2, '值不变时文件不变');

U.write_file(tmp, "log-level: info\nrules:\n  - MATCH,DIRECT\n");
eq(edit_commit(tmp, mode('direct')), null, '追加缺失的键');
eq(fs.readfile(tmp), "log-level: info\nrules:\n  - MATCH,DIRECT\nmode: direct\n", '缺失的键追加在末尾');

U.write_file(tmp, "mode: rule\nx: {\n  a: \"🇭🇰\"\n}\n");
eq(edit_commit(tmp, mode('direct')), null, '无法逐段拼接时退回整份输出');
let fb = fs.readfile(tmp);
ok(match(fb, /mode: direct/) && index(fb, '🇭🇰') >= 0 && index(fb, '\U') < 0, '整份输出也还原 emoji', fb);

// 合并键：merge 在条目这一层写显式键，锚点与其他条目不变
let anc = "p: &p\n  type: http\n  interval: 3600 # 每小时\n  health-check:\n    enable: true\n    interval: 300\npp:\n  A:\n    <<: *p\n    url: \"http://a/x?b=1&c=2\"\n  #B:\n  #  <<: *p\n  C:\n    <<: *p\n    url: http://c\nlist:\n  - x # 一\n  # 中间注释\n  - \"y,z\"\n  - w\n";
U.write_file(tmp, anc);
eq(edit_commit(tmp, [{ t: 'merge', p: ['pp', 'A'], v: { interval: 7200, 'health-check': { enable: true, interval: 60 } } }]), null, 'merge 成功');
let x = Y.query(tmp, 'explode(.)');
eq([x.pp.A.interval, x.pp.A['health-check'].interval, x.pp.C.interval, x.pp.C['health-check'].interval, x.p.interval], [7200, 60, 3600, 300, 3600], 'merge 只改条目本身，锚点不变');
ok(index(fs.readfile(tmp), 'interval: 3600 # 每小时') >= 0 && index(fs.readfile(tmp), '#B:') >= 0, 'merge 保留锚点行与注释');
eq(Y.query(tmp, '.pp.A | keys'), ['<<', 'url', 'interval', 'health-check'], 'merge 保留合并键');

U.write_file(tmp, anc);
eq(edit_commit(tmp, [{ t: 'merge', p: ['pp', 'A'], v: { url: 'http://new/?a=1&b=2', override: { 'additional-prefix': '[A]' }, n: '300' } }]), null, 'merge 覆盖显式键');
x = Y.query(tmp, 'explode(.)');
eq([x.pp.A.url, x.pp.A.override['additional-prefix'], x.pp.A.n], ['http://new/?a=1&b=2', '[A]', '300'], '需要引号的字符串写出后语义不变');

U.write_file(tmp, anc);
eq(edit_commit(tmp, [{ t: 'del', p: ['pp', 'C', 'url'] }, { t: 'set', p: ['pp', 'D'], v: { type: 'http', url: 'http://d' } }, { t: 'append', p: ['list'], v: 'v' }]), null, 'del、set、append');
x = Y.query(tmp, 'explode(.)');
eq([x.pp.C.url, x.pp.D, x.list], [null, { type: 'http', url: 'http://d' }, ['x', 'y,z', 'w', 'v']], 'del、set、append 结果');
ok(index(fs.readfile(tmp), '# 中间注释') >= 0, 'append 保留列表注释');

U.write_file(tmp, 'm:\n  a: 1\n  # 甲注释\n  b: 2\n  # 乙注释\n  c: 3\n  # 丙注释\n  d: 4\nz: 1\n');
eq(edit_commit(tmp, [{ t: 'del', p: ['m', 'b'] }, { t: 'del', p: ['m', 'd'] }, { t: 'del', p: ['m', 'a'] }]), null, 'del 带注释的键');
eq(Y.query(tmp, '.'), { m: { c: 3 }, z: 1 }, 'del 带注释的键结果');
ok(match(fs.readfile(tmp), /# 甲注释\n *# 乙注释\n *c: 3\n *# 丙注释\n/), 'del 时注释移到相邻键');
ok(Y.edit(tmp, [{ t: 'merge', p: ['a', 'b', 'c', 'd'], v: {} }]) != null, 'merge 路径过深时拒绝');
ok(Y.edit(tmp, [{ t: 'set', p: [], v: 1 }]) != null, '拒绝空路径');
ok(Y.edit(tmp, [{ t: 'set', p: [{}], v: 1 }]) != null, '拒绝非法路径元素');

U.write_file(tmp, anc);
eq(edit_commit(tmp, [{ t: 'list', p: ['list'], v: [{ k: 1 }, { v: 'new' }, { k: 0, v: 'x2' }, { k: 2 }] }]), null, 'list 重组');
eq(Y.query(tmp, '.list'), ['y,z', 'new', 'x2', 'w'], 'list 结果');
let lt = fs.readfile(tmp);
ok(index(lt, "  # 中间注释\n  - \"y,z\"") >= 0, 'list 注释随规则移动', lt);
ok(index(lt, "- x2 # 一") >= 0, 'list 编辑时保留原行尾注释', lt);
eq(edit_commit(tmp, [{ t: 'list', p: ['list'], v: [{ k: 9 }] }]) != null, true, 'list 下标越界时报错');

eq(Y.unescape_astral('"\\U0001F1ED\\U0001F1F0" \\\\U0001F1ED'), '"🇭🇰" \\\\U0001F1ED', 'unescape 只还原转义，保留双反斜杠');
let sec = Y.sections(split("a: 1\n# c\n\nb:\n  - x\n", '\n'));
eq(sec, [{ key: 'a', start: 0, end: 1 }, { key: 'b', start: 3, end: 5 }], 'sections 识别顶层键，段末注释归下一段');
eq(Y.sections(split("---\na: 1\n", '\n')), null, '多文档不逐段处理');
eq(Y.sections(split("a: 1\na: 2\n", '\n')), null, '重复键不逐段处理');

eq(length(filter(fs.lsdir(P.RUN_DIR), (n) => match(n, /^(ops?|edit)-/))), 0, '不留临时文件');

done();
