'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const cfg = load('view/mihomo/config.js', { view, api: {}, mui: {}, header: {} });

assert.strictEqual(cfg.lineNumbers('a\nb\nc'), '1\n2\n3');
assert.strictEqual(cfg.lineNumbers(''), '1');
assert.deepStrictEqual(cfg.indent('ab', 1, 1, false), { text: 'a  b', start: 3, end: 3 });
assert.deepStrictEqual(cfg.indent('x\ny', 0, 3, false), { text: '  x\n  y', start: 0, end: 7 });
assert.deepStrictEqual(cfg.indent('  x\n  y', 0, 7, true), { text: 'x\ny', start: 0, end: 3 });

assert.strictEqual(cfg.errorLine('校验失败：yaml: line 383: did not find expected node content'), 383);
assert.strictEqual(cfg.errorLine('proxy group 节点选择: proxy x not found'), null);
assert.strictEqual(cfg.errorLine(null), null);
assert.deepStrictEqual(cfg.lineRange('a\nbb\nccc', 2), { start: 2, end: 4 });
assert.deepStrictEqual(cfg.lineRange('a\nbb\nccc', 3), { start: 5, end: 8 });
assert.deepStrictEqual(cfg.lineRange('a\nbb', 9), { start: 2, end: 4 });

// yq 新格式的出错行取区间末尾
assert.strictEqual(cfg.errorLine('go-yaml load error in parser (while parsing a block mapping) at L1.C1-L4.C2: did not find expected key'), 4);
// 高亮：键、字符串、标量、注释、列表符号；HTML 转义；错误行包裹
const h = cfg.highlightLine('  - name: "a<b" # 备注');
assert.ok(h.includes('<span class="mh-hl-key" data-t="name"></span>') && h.includes('<span class="mh-hl-str" data-t="&quot;a&lt;b&quot;"></span>') && h.includes('<span class="mh-hl-cmt" data-t="# 备注"></span>') && h.includes('mh-hl-mark" data-t="- "></span>') && !/>[^<\n]+</.test(h), h);
assert.ok(cfg.highlightLine('port: 7890').includes('mh-hl-num" data-t="7890"'));
assert.ok(cfg.highlightLine('url: http://x/#frag').indexOf('mh-hl-cmt') < 0, '# 前没有空白时不是注释');
assert.ok(cfg.highlightLine("rules: ['a: b']").includes('mh-hl-key" data-t="rules"'));
assert.ok(cfg.highlight('a: 1\nb: [', 2).includes('<span class="mh-hl-err">'), '错误行加标记');
assert.strictEqual(cfg.highlight('a\n', null).split('\n').length, 3, '末尾补一行，避免最后的空行高度对不齐');
