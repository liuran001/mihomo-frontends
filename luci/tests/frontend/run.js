'use strict';
// 前端测试入口：先对全部资源文件做语法检查，再运行 test_*.js
const fs = require('fs');
const path = require('path');
const { ROOT, source } = require('./harness');

// shared/ 下的共用文件先同步成 LuCI 模块（生成的文件不入库）
require('child_process').execFileSync('sh', [path.join(__dirname, '../../scripts/sync-template.sh')], { stdio: 'inherit' });

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
		d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

let failed = 0;
for (const f of walk(ROOT).filter(f => f.endsWith('.js'))) {
	const rel = path.relative(ROOT, f);
	try {
		new Function(source(rel));
		console.log('syntax ok   ' + rel);
	} catch (e) {
		failed++;
		console.log('syntax FAIL ' + rel + ': ' + e.message);
	}
}

for (const t of fs.readdirSync(__dirname).filter(f => /^test_.*\.js$/.test(f))) {
	try {
		require(path.join(__dirname, t));
		console.log('pass        ' + t);
	} catch (e) {
		failed++;
		console.log('FAIL        ' + t + '\n' + (e.stack || e.message));
	}
}

console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
process.exit(failed ? 1 : 0);
