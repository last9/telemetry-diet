#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.yaml', '.yml']);
const TEXT_BASENAMES = new Set(['.editorconfig', '.gitignore']);

function repositoryFiles() {
  const output = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ]);
  return output.toString('utf8').split('\0').filter(Boolean);
}

function isTextFile(path) {
  const name = path.split('/').at(-1);
  return TEXT_EXTENSIONS.has(extname(path)) || TEXT_BASENAMES.has(name);
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const errors = [];
const files = repositoryFiles().filter(isTextFile);

for (const path of files) {
  const bytes = readFileSync(path);
  let content;
  try {
    content = decoder.decode(bytes);
  } catch {
    errors.push(`${path}: is not valid UTF-8`);
    continue;
  }
  if (content.includes('\r')) errors.push(`${path}: contains CR or CRLF line endings`);
  if (content && !content.endsWith('\n')) errors.push(`${path}: is missing a final newline`);
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`${path}:${index + 1}: has trailing whitespace`);
  });
  if (extname(path) === '.json') {
    try {
      const formatted = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
      if (content !== formatted) errors.push(`${path}: JSON must use two-space indentation`);
    } catch {
      errors.push(`${path}: is not valid JSON`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked text and JSON formatting in ${files.length} repository files.`);
}
