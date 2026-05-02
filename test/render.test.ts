import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderArtifacts, applyPlaceholders, renderMcpConfig } from '../src/render';

describe('applyPlaceholders', () => {
  it('substitutes {{KEY}} markers', () => {
    expect(applyPlaceholders('hello {{NAME}} world', { NAME: 'claude' })).toBe(
      'hello claude world',
    );
  });

  it('leaves unknown markers intact', () => {
    expect(applyPlaceholders('a {{UNKNOWN}} b', {})).toBe('a {{UNKNOWN}} b');
  });

  it('handles repeated keys', () => {
    expect(applyPlaceholders('{{X}}-{{X}}', { X: '1' })).toBe('1-1');
  });
});

describe('renderMcpConfig', () => {
  it('renders an HTTP MCP server pointing at <hub>/mcp with bearer token', () => {
    const out = renderMcpConfig({ hubUrl: 'https://hub.example.com', token: 'gnx_secret' });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      mcpServers: {
        gitnexus: {
          type: 'http',
          url: 'https://hub.example.com/mcp',
          headers: { Authorization: 'Bearer gnx_secret' },
        },
      },
    });
  });

  it('strips trailing slashes from hub URL', () => {
    const out = renderMcpConfig({ hubUrl: 'https://hub.example.com//', token: 't' });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.gitnexus.url).toBe('https://hub.example.com/mcp');
  });
});

describe('renderArtifacts', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-render-test-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('writes all three artifacts to the right paths', () => {
    const pack = {
      schemaVersion: 1,
      repo: { id: 'r1', fullName: 'a/b', indexedCommit: null, lastIndexedAt: null },
      warningsForClaude: ['coverage data not uploaded'],
    };
    const result = renderArtifacts({
      workspace,
      contextPack: pack,
      hubUrl: 'https://hub.example.com',
      token: 'gnx_test',
      repoFullName: 'abhigyanpatwari/deer-flow',
      prNumber: 42,
    });

    // 1. context-pack.json — JSON-serialised, round-trippable.
    expect(fs.existsSync(result.contextPackPath)).toBe(true);
    expect(result.contextPackPath).toBe(path.join(workspace, '.gitnexus', 'context-pack.json'));
    const onDisk = JSON.parse(fs.readFileSync(result.contextPackPath, 'utf8'));
    expect(onDisk).toEqual(pack);

    // 2. system-prompt.md — placeholders substituted.
    expect(result.systemPromptPath).toBe(path.join(workspace, '.gitnexus', 'system-prompt.md'));
    const prompt = fs.readFileSync(result.systemPromptPath, 'utf8');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('abhigyanpatwari/deer-flow');
    expect(prompt).toContain(result.contextPackPath);
    expect(prompt).toContain('https://hub.example.com');
    // No leftover unsubstituted placeholders.
    expect(prompt).not.toContain('{{CONTEXT_PACK_PATH}}');
    expect(prompt).not.toContain('{{HUB_URL}}');
    expect(prompt).not.toContain('{{REPO_FULL_NAME}}');
    expect(prompt).not.toContain('{{PR_NUMBER}}');
    // Sanity: includes the marker comment instruction so Claude posts
    // an updateable comment.
    expect(prompt).toContain('<!-- gitnexus-claude-review-v1 -->');
  });

  it('writes the MCP config under .claude/', () => {
    const result = renderArtifacts({
      workspace,
      contextPack: { schemaVersion: 1 },
      hubUrl: 'https://hub.example.com',
      token: 'gnx_t',
      repoFullName: 'a/b',
      prNumber: 1,
    });
    expect(result.mcpConfigPath).toBe(path.join(workspace, '.claude', 'gitnexus-mcp.json'));
    const cfg = JSON.parse(fs.readFileSync(result.mcpConfigPath, 'utf8'));
    expect(cfg.mcpServers.gitnexus.url).toBe('https://hub.example.com/mcp');
    expect(cfg.mcpServers.gitnexus.headers.Authorization).toBe('Bearer gnx_t');
  });
});
