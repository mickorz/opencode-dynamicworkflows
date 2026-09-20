#!/usr/bin/env node
// -*- coding: utf-8 -*-
// workflow 脚本语法检查：把 export const meta 改 const，包进 async IIFE，用 vm.Script 编译。
// 支持 workflow runtime 的顶层 await / return（ESM 模块顶层 return 在 node --check 下非法，故包装）。
// 用法: node wf-syntax-check.js <workflow.js> [more.js ...]  退出码 0 全通过，1 有错误。
const fs = require('fs');
const vm = require('vm');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node wf-syntax-check.js <workflow.js> [more.js ...]');
  process.exit(2);
}

let bad = 0;
for (const file of files) {
  let code;
  try {
    code = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error('[读取失败] ' + file + ': ' + e.message);
    bad++;
    continue;
  }
  const wrapped = '(async () => {\n' + code.replace('export const meta', 'const meta') + '\n})();';
  try {
    new vm.Script(wrapped, { filename: file });
    console.log('[通过] ' + file);
  } catch (e) {
    console.error('[语法错误] ' + file + ': ' + e.message);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
