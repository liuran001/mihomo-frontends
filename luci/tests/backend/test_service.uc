'use strict';

import * as fs from 'fs';
import * as P from 'mihomo.paths';
import * as S from 'mihomo.service';
import * as SY from 'mihomo.system';
import { ok, eq, done } from 'lib';

eq(S.action('rm -rf /').ok, false, '拒绝白名单外的操作');
ok(match(S.version() ?? '', /^[^ ]+$/), '能读到版本号', S.version());

let st = S.status();
eq(st.running, false, '测试服务名不在 procd 中时为未运行');
ok(st.config_rev != '', 'status 含配置 rev');
eq(st.yq_present, true, 'status 报告 yq');
eq(st.config_present, true, 'status 报告配置文件存在');

let c = S.controller();
eq([c.ok, c.reachable, c.port], [true, false, null], '回环控制器标记为浏览器不可直连');
ok(index(c.reason, '0.0.0.0:19090') >= 0, '提示正确写法', c.reason);
ok('ui' in c && 'ui_name' in c, 'controller 返回面板目录字段');
eq(c.tls, null, '没有 external-controller-tls 时 tls 为 null');

// TLS 监听：与明文分开上报，页面按协议选择
let conf = fs.readfile(P.CONFIG);
fs.writefile(P.CONFIG, conf + '\nexternal-controller-tls: 127.0.0.1:19443\n');
let ct = S.controller();
ok(ct.tls && !ct.tls.reachable, 'TLS 控制器回环时标记为不可直连', ct.tls);
ok(index(ct.tls.reason, 'external-controller-tls') >= 0, 'TLS 提示正确写法', ct.tls.reason);
fs.writefile(P.CONFIG, conf + '\nexternal-controller-tls: 0.0.0.0:19443\n');
ct = S.controller();
eq([ct.tls.reachable, ct.tls.host, ct.tls.port], [true, null, 19443], 'TLS 控制器监听通配地址时浏览器可直连');
fs.writefile(P.CONFIG, conf);
eq(S.controller().tls, null, '恢复配置后 tls 为 null');

eq(S.action('start').ok, true, '通过 init 脚本启动');
sleep(1500);
ok(S.running(), 'running() 为真');
eq(S.action('stop').ok, true, '停止');
ok(!S.running(), 'running() 为假');

let pi = S.proc_info(+fs.readlink('/proc/self'));
ok(pi.uptime >= 0 && pi.rss_kb > 0, 'proc_info 解析运行时长与内存', pi);

let lg = SY.logs(5);
ok(lg.ok && length(split(lg.text, '\n')) <= 5, 'logs 按行数截取');
eq(SY.logs(99999).ok, true, 'logs 行数越界时使用默认值');

done();
