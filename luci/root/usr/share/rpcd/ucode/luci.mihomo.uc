'use strict';

import * as A from 'mihomo.apply';
import * as F from 'mihomo.forms';
import * as PR from 'mihomo.probe';
import * as S from 'mihomo.service';
import * as SY from 'mihomo.system';
import * as CORE from 'mihomo.core';
import * as SU from 'mihomo.setup';
import * as SS from 'mihomo.substore';

// 所有方法返回 { ok: true, ... } 或 { ok: false, error, detail }；异常也转换成这种形式
function wrap(fn) {
	return function(req) {
		try {
			return fn(req.args ?? {});
		} catch (e) {
			return { ok: false, error: '后端异常：' + e.message };
		}
	};
}

return {
	'luci.mihomo': {
		status:         { call: wrap(() => ({ ok: true, ...S.status() })) },
		controller:     { call: wrap(() => S.controller()) },
		config_read:    { call: wrap(() => A.config_read()) },
		backups:        { call: wrap(() => ({ ok: true, list: A.backups() })) },
		backup_read:    { args: { name: '' }, call: wrap((a) => A.backup_read(a.name)) },
		logs:           { args: { lines: 0 }, call: wrap((a) => SY.logs(a.lines)) },
		diagnostics:    { call: wrap(() => SY.diagnostics()) },
		substore_status: { call: wrap(() => SS.status()) },
		substore_list:  { call: wrap(() => SS.list()) },
		substore_set:   { args: { mode: '', port: 0, lan: false, url: '' }, call: wrap((a) => SS.set(a)) },
		substore_install: { args: { what: '' }, call: wrap((a) => SS.install(a.what || 'all')) },
		substore_service: { args: { action: '' }, call: wrap((a) => SS.service(a.action)) },
		devices:        { call: wrap(() => SY.devices()) },
		sections:       { args: { names: [] }, call: wrap((a) => F.sections(a.names)) },
		interfaces:     { call: wrap(() => SY.interfaces()) },
		tailscale:      { call: wrap(() => SY.tailscale_status()) },
		tailscale_logout: { args: { name: '' }, call: wrap((a) => SY.tailscale_logout(a.name)) },
		apply_status:   { args: { job: '' }, call: wrap((a) => A.job_status(a.job)) },
		validate:       { args: { content: '' }, call: wrap((a) => A.validate_content(a.content)) },
		yaml_check:     { args: { content: '' }, call: wrap((a) => A.yaml_check(a.content)) },
		save_raw:       { args: { content: '', rev: '' }, call: wrap((a) => A.begin('raw', a)) },
		patch:          { args: { ops: [], rev: '' }, call: wrap((a) => A.begin('patch', a)) },
		provider_toggle: { args: { name: '', enabled: false, rev: '' },
			call: wrap((a) => A.begin('patch', { ops: [{ op: 'provider.toggle', name: a.name, enabled: a.enabled }], rev: a.rev })) },
		migrate_include_all: { args: { rev: '' },
			call: wrap((a) => A.begin('patch', { ops: [{ op: 'groups.include_all' }], rev: a.rev })) },
		backup_restore: { args: { name: '' }, call: wrap((a) => A.begin('restore', a)) },
		backup_delete:  { args: { name: '' }, call: wrap((a) => A.backup_delete(a.name)) },
		service:        { args: { action: '' }, call: wrap((a) => S.action(a.action)) },
		rule_test:      { args: { target: '' }, call: wrap((a) => PR.rule_test(a.target)) },
		core_info:      { call: wrap(() => CORE.info()) },
		core_check:     { call: wrap(() => CORE.check()) },
		core_update:    { args: { force: false }, call: wrap((a) => A.begin('core', a)) },
		core_rollback:  { call: wrap(() => A.begin('core_rollback', {})) },
		core_settings:  { args: { repo: '', tag: '', mirror: '' }, call: wrap((a) => CORE.settings_set(a)) },
		setup_status:   { call: wrap(() => SU.status()) },
		setup_render:   { args: { subs: [], lan: [], secret: '' }, call: wrap((a) => SU.render(a)) },
		setup_fetch:    { args: { url: '', ua: '' }, call: wrap((a) => SU.fetch_config(a)) },
		setup_adapt:    { args: { content: '', lan: [], secret: '', skip: [] }, call: wrap((a) => SU.adapt_preview(a)) },
		setup_apply:    { args: { source: '', subs: [], lan: [], secret: '', content: '', url: '', ua: '', adapt: false, skip: [], start: false, rev: '' },
			call: wrap((a) => A.begin('setup', a)) }
	}
};
