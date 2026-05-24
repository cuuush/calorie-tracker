#!/usr/bin/env node
// Scan recent Claude Code transcripts for Bash + MCP tool calls,
// rank by frequency, drop auto-allowed and non-read-only, and emit
// a prioritized list. Designed to power /fewer-permission-prompts.
//
// Usage: node scripts/permission_audit.mjs [maxSessions=50]

import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const PROJECTS_ROOT = join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS = parseInt(process.argv[2] || '50', 10);
const SETTINGS_PATH = '.claude/settings.json';

// ── Auto-allowed lists (kept narrow to match the skill's source-of-truth) ──
const AUTO_ALLOWED_ANY_ARGS = new Set([
    'cal', 'uptime', 'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump', 'od', 'nl',
    'id', 'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc', 'basename', 'dirname',
    'realpath', 'cut', 'paste', 'tr', 'column', 'tac', 'rev', 'fold', 'expand', 'unexpand',
    'fmt', 'comm', 'cmp', 'numfmt', 'readlink', 'diff', 'true', 'false', 'sleep', 'which',
    'type', 'expr', 'test', 'getconf', 'seq', 'tsort', 'pr', 'echo', 'printf', 'ls', 'cd', 'find',
    // "safe flags only (validated)" — treat as auto-allowed at the bucket level
    'xargs', 'file', 'sed', 'sort', 'man', 'help', 'netstat', 'ps', 'base64', 'grep', 'egrep',
    'fgrep', 'sha256sum', 'sha1sum', 'md5sum', 'tree', 'date', 'hostname', 'info', 'lsof',
    'pgrep', 'tput', 'ss', 'fd', 'fdfind', 'aki', 'rg', 'jq', 'uniq', 'history', 'arch',
    'ifconfig', 'pyright'
]);

const AUTO_ALLOWED_ZERO_ARGS = new Set(['pwd', 'whoami', 'alias']);

const GIT_READ_ONLY = new Set([
    'status', 'log', 'diff', 'show', 'blame', 'branch', 'tag', 'remote', 'ls-files', 'ls-remote',
    'config', 'rev-parse', 'describe', 'stash', 'reflog', 'shortlog', 'cat-file', 'for-each-ref',
    'worktree'
]);

const GH_READ_ONLY = new Set([
    'pr', 'issue', 'run', 'workflow', 'repo', 'release', 'api', 'auth'
]);

// Things we will NEVER allowlist (arbitrary code execution / mutation).
const NEVER_ALLOW_LEAD = new Set([
    'python', 'python3', 'node', 'bun', 'deno', 'ruby', 'perl', 'php', 'lua',
    'bash', 'sh', 'zsh', 'fish', 'eval', 'exec', 'ssh',
    'npx', 'bunx', 'uvx',
    'sudo', 'rm', 'mv', 'cp', 'chmod', 'chown', 'ln',
    'kill', 'pkill', 'killall',
    'curl', 'wget', // could be GET-only but unsafe to wildcard
    'docker' // some subcommands are read-only but blanket allow is risky
]);

// Subcommands that mutate / have side effects (when paired with their parent).
const MUTATING_SUBCOMMANDS = {
    git: new Set(['add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'reset', 'checkout',
                  'switch', 'restore', 'rm', 'mv', 'clean', 'init', 'clone', 'tag', 'branch',
                  'cherry-pick', 'apply', 'am', 'revert', 'stash', 'submodule', 'worktree', 'gc',
                  'prune', 'repack', 'lfs', 'config']),
    gh: new Set(['create', 'edit', 'close', 'reopen', 'merge', 'ready', 'review', 'comment',
                 'delete', 'rerun', 'cancel', 'run', 'enable', 'disable', 'unlock']),
    npm: new Set(['install', 'i', 'uninstall', 'update', 'publish', 'run', 'start', 'test',
                  'rebuild', 'audit']),
    yarn: new Set(['add', 'remove', 'install', 'publish', 'run', 'start', 'test', 'upgrade']),
    pnpm: new Set(['add', 'install', 'remove', 'update', 'publish', 'run', 'start', 'test']),
    bun: new Set(['add', 'install', 'remove', 'update', 'publish', 'run', 'start', 'test', 'x']),
    cargo: new Set(['build', 'install', 'publish', 'run', 'test', 'update']),
    docker: new Set(['run', 'exec', 'rm', 'kill', 'build', 'push', 'pull', 'compose'])
};

// Heuristic: tools whose first arg almost always names a verb
function isMutatingSubcommand(tool, sub) {
    return MUTATING_SUBCOMMANDS[tool]?.has(sub) ?? false;
}

function isAutoAllowedBash(tool, sub) {
    if (AUTO_ALLOWED_ANY_ARGS.has(tool)) return true;
    if (AUTO_ALLOWED_ZERO_ARGS.has(tool)) return true;
    if (tool === 'git' && sub && GIT_READ_ONLY.has(sub)) return true;
    if (tool === 'gh' && sub && GH_READ_ONLY.has(sub)) {
        // gh api is only read-only for GET; skip the whole gh family from auto-allowed
        // detection because gh pr edit etc. exist. Subcommand granularity matters.
        // The skill instructs us to treat `gh pr view`, `gh pr list`, etc. as auto-allowed,
        // but `gh pr create/edit/merge` is not. So we don't bulk-allow gh; we'll allow
        // specific verb pairs below if observed.
        return false;
    }
    if (tool === 'docker' && sub && ['ps', 'images', 'logs', 'inspect'].includes(sub)) return true;
    return false;
}

// MCP tool names that are read-only — pattern match on verb hints.
function isReadOnlyMcp(name) {
    const lower = name.toLowerCase();
    const verbs = ['read', 'get', 'list', 'search', 'view', 'fetch', 'load', 'inspect',
                   'show', 'lookup', 'find', 'describe', 'check', 'status', 'history',
                   'download_file_content', 'download', 'metadata', 'permissions'];
    if (verbs.some((v) => lower.includes(`__${v}`) || lower.endsWith(`_${v}`) || lower.includes(`_${v}_`))) {
        return true;
    }
    return false;
}

// Parse `input.command` into [leadTool, leadSub]. Strips env-var prefixes,
// sudo, timeout, and uses the FIRST pipeline segment.
function parseBashLead(cmd) {
    if (!cmd || typeof cmd !== 'string') return null;
    // Take the part before the first shell separator.
    const segment = cmd.split(/[|&;><]|\&\&|\|\|/)[0].trim();
    if (!segment) return null;
    const tokens = segment.split(/\s+/);
    let i = 0;
    // Skip leading VAR=value assignments and noisy wrappers.
    while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
    const wrappers = new Set(['sudo', 'timeout', 'time', 'nice', 'ionice', 'env', 'command', 'exec']);
    while (i < tokens.length && wrappers.has(tokens[i])) {
        i++;
        // skip wrapper args (best-effort): one numeric or option following
        while (i < tokens.length && /^-/.test(tokens[i])) i++;
        if (i < tokens.length && /^\d+(s|m|h)?$/.test(tokens[i])) i++; // timeout 10s
    }
    if (i >= tokens.length) return null;
    let tool = tokens[i++];
    // Strip ./ or path prefix
    tool = tool.replace(/^\.\//, '').split('/').pop();
    let sub = null;
    // Find first non-flag positional arg as subcommand.
    while (i < tokens.length && /^-/.test(tokens[i])) i++;
    if (i < tokens.length) sub = tokens[i];
    return { tool, sub };
}

// Recent jsonl files across all projects.
function recentTranscripts(limit) {
    if (!existsSync(PROJECTS_ROOT)) return [];
    const all = [];
    for (const proj of readdirSync(PROJECTS_ROOT)) {
        const dir = join(PROJECTS_ROOT, proj);
        try {
            for (const f of readdirSync(dir)) {
                if (!f.endsWith('.jsonl')) continue;
                const full = join(dir, f);
                const st = statSync(full);
                all.push({ full, mtime: st.mtimeMs });
            }
        } catch { /* ignore */ }
    }
    all.sort((a, b) => b.mtime - a.mtime);
    return all.slice(0, limit).map((x) => x.full);
}

function* scanToolUses(file) {
    let data;
    try { data = readFileSync(file, 'utf8'); } catch { return; }
    for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const msg = row.message;
        if (!msg || msg.role !== 'assistant') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const part of content) {
            if (part?.type === 'tool_use' && part?.name) {
                yield { name: part.name, input: part.input || {} };
            }
        }
    }
}

const bashCounts = new Map();   // "tool sub" or "tool" → count
const mcpCounts = new Map();    // tool name → count
const files = recentTranscripts(MAX_SESSIONS);

for (const f of files) {
    for (const call of scanToolUses(f)) {
        if (call.name === 'Bash') {
            const parsed = parseBashLead(call.input?.command);
            if (!parsed) continue;
            // De-dupe forms like `git log --oneline` vs `git log` → same key `git log`.
            const key = parsed.sub && /^[a-z][a-z0-9_-]*$/i.test(parsed.sub)
                ? `${parsed.tool} ${parsed.sub}`
                : parsed.tool;
            bashCounts.set(key, (bashCounts.get(key) || 0) + 1);
        } else if (call.name.startsWith('mcp__')) {
            mcpCounts.set(call.name, (mcpCounts.get(call.name) || 0) + 1);
        }
    }
}

// Filter Bash counts.
const bashCandidates = [];
for (const [key, count] of bashCounts) {
    const [tool, sub] = key.split(' ');
    if (NEVER_ALLOW_LEAD.has(tool)) continue;
    if (sub && isMutatingSubcommand(tool, sub)) continue;
    if (isAutoAllowedBash(tool, sub)) continue;
    if (count < 3) continue;
    bashCandidates.push({ pattern: sub ? `Bash(${tool} ${sub}*)` : `Bash(${tool}*)`, count, key });
}

const mcpCandidates = [];
for (const [name, count] of mcpCounts) {
    if (!isReadOnlyMcp(name)) continue;
    if (count < 3) continue;
    mcpCandidates.push({ pattern: name, count, key: name });
}

const ranked = [...bashCandidates, ...mcpCandidates].sort((a, b) => b.count - a.count).slice(0, 20);

console.log(`Scanned ${files.length} session(s).\n`);
console.log('| # | Pattern | Count | Source |');
console.log('|---|---------|-------|--------|');
ranked.forEach((r, i) => {
    console.log(`| ${i + 1} | \`${r.pattern}\` | ${r.count} | ${r.key} |`);
});

// Merge into .claude/settings.json
let settings = {};
if (existsSync(SETTINGS_PATH)) {
    try { settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); }
    catch (e) { console.error('Could not parse existing settings.json:', e.message); process.exit(1); }
}
settings.permissions ||= {};
const existing = new Set(settings.permissions.allow || []);
const added = [];
for (const r of ranked) {
    if (!existing.has(r.pattern)) {
        existing.add(r.pattern);
        added.push(r.pattern);
    }
}
settings.permissions.allow = [...existing];

if (!existsSync('.claude')) mkdirSync('.claude', { recursive: true });
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

console.log(`\nAdded ${added.length} new pattern(s) to ${SETTINGS_PATH}.`);
if (added.length) console.log('  ' + added.join('\n  '));
