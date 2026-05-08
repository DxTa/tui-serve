#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(process.argv[2] || join(__dirname, '..', 'tui-web', 'dist'));
const indexPath = join(distDir, 'index.html');

function fail(message) {
  console.error(`web dist validation failed: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(indexPath)) {
  fail(`missing ${indexPath}`);
  process.exit();
}

const html = readFileSync(indexPath, 'utf8');
const refs = new Set();
const manifestRefs = new Set();
const patterns = [
  /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi,
  /<link\b[^>]+href=["']([^"']+)["'][^>]*rel=["']manifest["']/gi,
];

for (const pattern of patterns) {
  for (const match of html.matchAll(pattern)) {
    const ref = match[1];
    if (!ref || /^(?:https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
    refs.add(ref.split(/[?#]/, 1)[0]);
  }
}

for (const ref of refs) {
  const rel = ref.startsWith('/') ? ref.slice(1) : ref;
  const target = join(distDir, rel);
  if (!existsSync(target)) {
    fail(`index.html references missing file: ${ref}`);
    continue;
  }
  if (!statSync(target).isFile()) {
    fail(`index.html reference is not a file: ${ref}`);
  }
}

const manifestPath = join(distDir, 'manifest.webmanifest');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const icon of manifest.icons || []) {
    if (icon?.src) manifestRefs.add(icon.src.split(/[?#]/, 1)[0]);
  }
}

for (const ref of manifestRefs) {
  if (/^(?:https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
  const rel = ref.startsWith('/') ? ref.slice(1) : ref;
  const target = join(distDir, rel);
  if (!existsSync(target)) {
    fail(`manifest.webmanifest references missing file: ${ref}`);
    continue;
  }
  if (!statSync(target).isFile()) {
    fail(`manifest.webmanifest reference is not a file: ${ref}`);
  }
}

if (process.exitCode) process.exit();
console.log(`web dist validation passed: ${refs.size} index.html refs, ${manifestRefs.size} manifest refs checked in ${distDir}`);
