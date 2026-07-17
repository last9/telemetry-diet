#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';

const root = process.cwd();
const filesResult = spawnSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md',
], { encoding: 'utf8' });
if (filesResult.status !== 0) throw new Error(filesResult.stderr || 'Could not list Markdown files.');

const files = filesResult.stdout.split('\0').filter(Boolean);
const failures = [];

function withoutCodeBlocks(markdown) {
  return markdown
    .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
    .replace(/^~~~[^\n]*\n[\s\S]*?^~~~\s*$/gm, '');
}

function headingAnchors(markdown) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of withoutCodeBlocks(markdown).split('\n')) {
    const match = /^(?: {0,3})#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const duplicate = seen.get(base) || 0;
    seen.set(base, duplicate + 1);
    anchors.add(duplicate ? `${base}-${duplicate}` : base);
  }
  return anchors;
}

for (const file of files) {
  const absoluteFile = resolve(root, file);
  const markdown = withoutCodeBlocks(readFileSync(absoluteFile, 'utf8'));
  const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    const destination = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//')) continue;

    const [pathWithQuery, encodedAnchor] = destination.split('#', 2);
    const targetPath = decodeURIComponent(pathWithQuery.split('?', 1)[0]);
    const target = targetPath ? resolve(dirname(absoluteFile), targetPath) : absoluteFile;
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      failures.push(`${file}: link escapes the repository: ${destination}`);
      continue;
    }
    if (!existsSync(target)) {
      failures.push(`${file}: missing link target: ${destination}`);
      continue;
    }
    if (encodedAnchor && extname(target).toLowerCase() === '.md') {
      const anchor = decodeURIComponent(encodedAnchor).toLowerCase();
      const anchors = headingAnchors(readFileSync(target, 'utf8'));
      if (!anchors.has(anchor)) failures.push(`${file}: missing heading anchor: ${destination}`);
    }
  }
}

if (failures.length) throw new Error(`Markdown link validation failed:\n${failures.join('\n')}`);
console.log(`Validated relative links in ${files.length} Markdown files.`);
