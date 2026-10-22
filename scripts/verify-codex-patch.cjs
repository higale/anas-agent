// Development-only reference runner. Rust is not used by the application/build.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')

const revision = 'a6839a481223fb5faab539a9eb2b7174ae29e560'
const blobs = {
  'parser.rs': 'c400d075a684fda29c10269aef1958a27faf90aa',
  'streaming_parser.rs': 'ff1b2f82feec7bdf454f6cba61ad5f15611f5573',
  'seek_sequence.rs': 'c8555ef9e23a1af77be811292a12bedcdf0ca049',
  'file_update.rs': '06c3455c9c9943d500f2c0fec53b1017aabd1662',
  'text_file.rs': 'b7d598ca973ec73f0ed064d2360f4d218e2a792d'
}
const toolBlobs = {
  'codex-rs/core/assets/tools/apply_patch.lark': '5aa41b0af797a0bde0dc2459c272c9af63e96dc3',
  'codex-rs/core/src/tools/handlers/apply_patch_spec.rs': '9efd8f9d8da73e9ba3d182627e51840d2d1b85ce'
}
const root = path.resolve(__dirname, '..')
const work = path.join(root, 'tmp/codex-patch-reference')
const fixture = path.join(root, 'src/main/test-fixtures/codex-patch.json')
const raw = `https://raw.githubusercontent.com/openai/codex/${revision}/`
const blobHash = (buffer) => crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
async function download(relative, hash) {
  const local = path.join(work, 'upstream', relative)
  let buffer
  try { buffer = await fs.readFile(local) } catch { /* Fetch an absent cache entry. */ }
  if (!buffer || (hash && blobHash(buffer) !== hash)) {
    const response = await fetch(raw + relative)
    if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`)
    buffer = Buffer.from(await response.arrayBuffer())
    if (hash && blobHash(buffer) !== hash) throw new Error(`Upstream Git blob mismatch: ${relative}`)
    await fs.mkdir(path.dirname(local), { recursive: true })
    await fs.writeFile(local, buffer)
  }
  return buffer.toString('utf8')
}
async function prepareReference() {
  await fs.mkdir(path.join(work, 'src'), { recursive: true })
  const source = Object.fromEntries(await Promise.all(Object.entries(blobs).map(async ([file, hash]) =>
    [file, await download(`codex-rs/apply-patch/src/${file}`, hash)])))
  // Exclude only host path resolution. Parser/state machine bodies stay verbatim.
  const parser = source['parser.rs']
    .replace('use codex_utils_path_uri::PathUri;\n', '')
    .replace('use codex_utils_path_uri::PathUriParseError;\n', '')
    .replace('use std::path::Path;\n', '')
  const implStart = parser.indexOf('impl Hunk {')
  const implEnd = parser.indexOf('#[cfg(test)]\nuse Hunk::*;', implStart)
  assert(implStart > 0 && implEnd > implStart)
  await fs.writeFile(path.join(work, 'src/parser.rs'), parser.slice(0, implStart) + parser.slice(implEnd))
  for (const file of ['streaming_parser.rs', 'seek_sequence.rs', 'text_file.rs']) {
    await fs.writeFile(path.join(work, 'src', file), source[file])
  }
  const compute = source['file_update.rs']
  const computeStart = compute.indexOf('fn compute_replacements(')
  const computeEnd = compute.indexOf('/// Intended result of a file update', computeStart)
  assert(computeStart > 0 && computeEnd > computeStart)
  await fs.writeFile(path.join(work, 'src/compute.rs'), compute.slice(computeStart, computeEnd))
  await fs.writeFile(path.join(work, 'Cargo.toml'), `[package]
name = "anas-codex-patch-reference"
version = "0.0.0"
edition = "2024"
[dependencies]
serde_json = "=1.0.145"
thiserror = "=2.0.17"
`)
  await fs.writeFile(path.join(work, 'src/main.rs'), `#![allow(dead_code)]
use std::io::{self, BufRead};
use serde_json::{json, Value};
mod parser;
mod streaming_parser;
mod seek_sequence;
mod text_file;
use parser::{Hunk, UpdateFileChunk};
use text_file::{Replacement, SourceFile};
#[derive(Debug, PartialEq)]
pub struct ApplyPatchArgs {
    pub patch: String, pub hunks: Vec<Hunk>, pub workdir: Option<String>, pub environment_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
enum ApplyPatchError { #[error("{0}")] ComputeReplacements(String) }
include!("compute.rs");
fn evaluate(input: Value) -> Value {
    let parsed = match parser::parse_patch(input["patch"].as_str().unwrap()) {
        Ok(value) => value, Err(error) => return json!({"error": error.to_string()}),
    };
    let hunks: Vec<Value> = parsed.hunks.iter().map(|h| match h {
        Hunk::AddFile { path, contents } => json!({"type":"add", "path":path, "contents":contents}),
        Hunk::DeleteFile { path } => json!({"type":"delete", "path":path}),
        Hunk::UpdateFile { path, move_path, chunks } => {
            let chunks: Vec<Value> = chunks.iter().map(|c| {
                let mut value = json!({"oldLines":c.old_lines, "newLines":c.new_lines,
                    "contextLineIndices":c.context_line_indices, "isEndOfFile":c.is_end_of_file});
                if let Some(ctx) = &c.change_context { value["changeContext"] = json!(ctx); }
                value
            }).collect();
            let mut value = json!({"type":"update", "path":path, "chunks":chunks});
            if let Some(dest) = move_path { value["movePath"] = json!(dest); }
            value
        }
    }).collect();
    let mut result = json!({"parsed":{"patch":parsed.patch, "hunks":hunks}, "updates":[]});
    if let Some(id) = parsed.environment_id { result["parsed"]["environmentId"] = json!(id); }
    for h in &parsed.hunks {
        if let Hunk::UpdateFile { path, chunks, .. } = h {
            let name = path.to_string_lossy();
            if let Some(source) = input["sources"][name.as_ref()].as_str() {
                let mut file = SourceFile::parse(source);
                let outcome = match compute_replacements(&file.line_texts(), &name, chunks) {
                    Ok(replacements) => { file.apply_replacements(&replacements); json!({"path":path,"content":file.into_contents()}) },
                    Err(error) => json!({"path":path,"error":error.to_string()}),
                };
                result["updates"].as_array_mut().unwrap().push(outcome);
            }
        }
    }
    result
}
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        println!("{}", evaluate(input));
    }
}
`)
  const built = spawnSync('cargo', ['build', '--quiet', '--release', '--manifest-path', path.join(work, 'Cargo.toml')],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300_000 })
  if (built.status !== 0) throw new Error(built.stderr || String(built.error))
}

async function referenceToolSpec() {
  const [grammar, source] = await Promise.all(Object.entries(toolBlobs).map(([file, hash]) => download(file, hash)))
  const description = source.match(/description: "([^"]+)"\.to_string\(\)/)?.[1]
  assert(description, 'Upstream tool declaration changed')
  return { type: 'custom', name: 'apply_patch', description, format: { type: 'grammar', syntax: 'lark', definition: grammar } }
}

async function cases() {
  const result = []
  const patch = (body) => `*** Begin Patch\n*** Update File: file\n${body}\n*** End Patch`
  const add = (name, body, source) => result.push({ name, patch: patch(body), sources: { file: source } })
  add('reported-single-space', '@@\n-     <span class="char">你</span><span class="char">好</span>\n+      <span class="char">你好中国</span>', '      <span class="char">你</span><span class="char">好</span>\n')
  add('reported-multiline', '@@\n .subtitle {\n       margin-top: 16px;\n-      animation: fadeUp 1s ease forwards 1.4s;\n+      animation: fadeUp 1s ease forwards 1s;\n     }', '.subtitle {\n\tmargin-top: 16px;\n  animation: fadeUp 1s ease forwards 1.4s;\n}\n')
  const bodies = ['@@\n-old\n+new', '-old\n+new', '@@\n old', '@@ old\n+new', '@@\n+new', '@@\n-old\n+new\n*** End of File', '@@\n-old\n+new\n ', '@@\n-old\n+new\n', '@@\n-old\n+new\n@@\n-tail\n+TAIL', '@@\n-old\n+new\n@@\n-old\n+again']
  const sources = ['', 'old', 'old\n', ' old\n', '\told \r\n', 'old\rother\r', 'old\r\ntail\n', 'old\nold\n', ' old\nold\n', 'head\nold\ntail', '\ufeffold\n', '\u0085old\n', 'old\n\n']
  for (const [i, body] of bodies.entries()) for (const [j, source] of sources.entries()) add(`boundary-${i}-${j}`, body, source)
  for (const character of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212', '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e', '\u201f', '\u00a0', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u202f', '\u205f', '\u3000', '\ufeff', '\u0085']) {
    for (const expected of ['-', "'", '"', ' ']) add(`unicode-${character.charCodeAt(0)}-${expected}`, `@@\n-a${expected}b\n+new`, `a${character}b\n`)
  }
  const malformed = ['', 'bad', '*** Begin Patch\n*** End Patch', '*** Begin Patch', '*** Begin Patch\n*** Update File: file\n*** End Patch', '*** Begin Patch\n*** Update File: file\n*** Move to: other\n*** End Patch', '*** Begin Patch\n*** Update File: file\n@@\n@@\n-old\n+new\n*** End Patch', '*** Begin Patch\n*** Add File: file\nnew\n*** End Patch']
  const valid = patch('@@\n-old\n+new')
  for (const body of ['@@\n-old\n+new\n\\ No newline at end of file', '@@\n-old\n\\ No newline at end of file\n+new',
    '@@\n-old\n+new\n*** End of File\n@@\n+extra', '@@\n unchanged\n-old\n+new\n tail']) {
    add(`format-${result.length}`, body, ' unchanged \r\nold\ntail')
  }
  add('strictness-before-position', '@@\n-old\n+new', ' old \nold\n')
  add('append-after-anchor', '@@ first\n+added', 'first\nlast\n')
  add('context-keeps-original-whitespace', '@@\n unchanged\n-old\n+new\n tail', '\tunchanged \r\nold\n tail\r')
  for (const [i, value] of [...malformed, valid.replaceAll('\n', '\r\n'), valid.replaceAll('\n', '\r\r\n'), ' \t\n' + valid + '\n \t', '\ufeff' + valid, "<<'EOF'\n" + valid + '\nEOF', '<<EOF\n' + valid + '\nBAD-EOF', valid.replace('*** Update', '  *** Update'), valid.replace('*** End Patch', '  *** End Patch'), valid.replace('@@', '@@ -1 +1 @@'), valid.replace('@@', '*** End of File\n@@'), valid.replace('@@', '@@\n-old\n+new\n*** End of File\n@@'), valid.replace('*** Update File:', '*** Environment ID: remote\n*** Update File:')].entries()) {
    result.push({ name: `parse-${i}`, patch: value, sources: { file: 'old\n' } })
  }
  let seed = 0x51a7beef
  const random = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n }
  const words = ['alpha', 'beta', '', '  gamma', '\tdelta', '“quoted”', '你好', '\ufeffheader', '\u0085space']
  for (let i = 0; i < 1200; i++) {
    const lines = Array.from({ length: 1 + random(12) }, () => words[random(words.length)])
    const endings = ['\n', '\r\n', '\r']
    let source = lines.map((line) => line + endings[random(3)]).join('')
    if (random(3) === 0) source = source.replace(/[\r\n]+$/, '')
    const start = random(lines.length), length = 1 + random(lines.length - start)
    const old = lines.slice(start, start + length).map((line) => random(3) ? line : ' ' + line.trim())
    const body = ['@@', ...(random(5) === 0 ? [' context'] : []), ...old.map((line) => '-' + line), '+replacement', ...(random(5) === 0 ? ['*** End of File'] : [])].join('\n')
    add(`generated-${i}`, body, source)
  }
  const treePath = path.join(work, 'tree.json')
  let treeData
  try { treeData = JSON.parse((await fs.readFile(treePath, 'utf8')).replace(/^\uFEFF/, '')) } catch {
    const treeResponse = await fetch(`https://api.github.com/repos/openai/codex/git/trees/${revision}?recursive=1`)
    if (!treeResponse.ok) throw new Error(`Git tree HTTP ${treeResponse.status}`)
    treeData = await treeResponse.json()
    await fs.writeFile(treePath, JSON.stringify(treeData))
  }
  assert.equal(treeData.sha, revision)
  const tree = treeData.tree
  const prefix = 'codex-rs/apply-patch/tests/fixtures/scenarios/'
  for (const entry of tree.filter((entry) => entry.path.startsWith(prefix) && entry.path.endsWith('/patch.txt'))) {
    const dir = entry.path.slice(0, -'patch.txt'.length)
    const inputs = tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith(dir + 'input/'))
    const sources = Object.fromEntries(await Promise.all(inputs.map(async (entry) =>
      [entry.path.slice((dir + 'input/').length), await download(entry.path, entry.sha)])))
    result.push({ name: `upstream-${dir.slice(prefix.length, -1)}`, patch: await download(entry.path, entry.sha), sources })
  }
  return result
}

async function main() {
  await prepareReference()
  const toolSpec = await referenceToolSpec()
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'src/main/codexPatchSpec.json'), 'utf8')), toolSpec, 'Tool description/grammar must match upstream verbatim')
  const update = process.argv.includes('--update')
  const saved = update ? undefined : JSON.parse(await fs.readFile(fixture, 'utf8'))
  if (saved) {
    assert.equal(saved.revision, revision)
    assert.deepEqual(saved.blobs, blobs)
    assert.deepEqual(saved.toolSpec, toolSpec)
  }
  const entries = update ? await cases() : saved.cases
  const executable = path.join(work, 'target/release/anas-codex-patch-reference' + (process.platform === 'win32' ? '.exe' : ''))
  const run = spawnSync(executable, [], { input: entries.map(({ patch, sources }) => JSON.stringify({ patch, sources })).join('\n') + '\n',
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
  if (run.status !== 0) throw new Error(run.stderr || String(run.error))
  const outputs = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(outputs.length, entries.length)
  if (update) {
    await fs.mkdir(path.dirname(fixture), { recursive: true })
    const header = JSON.stringify({ revision, blobs, toolSpec }).slice(0, -1)
    await fs.writeFile(fixture, header + ',"cases":[\n'
      + entries.map((entry, i) => JSON.stringify({ ...entry, expected: outputs[i] })).join(',\n') + '\n]}\n')
  } else entries.forEach((entry, i) => assert.deepEqual(outputs[i], entry.expected, entry.name))
  console.log(`${entries.length} cases ${update ? 'recorded from' : 'verified against'} upstream Rust ${revision}`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
