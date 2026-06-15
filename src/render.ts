import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextPack } from './context-pack';

/**
 * Materialise the three artifacts the next workflow step (Claude action)
 * consumes:
 *
 *   1. context-pack.json — verbatim copy of the JSON returned from
 *      the Hub. Claude reads this on first invocation per the system
 *      prompt's instructions.
 *   2. system-prompt.md  — the GitNexus PR-review skill, rendered with
 *      the Context Pack path and PR identifiers substituted in.
 *   3. .claude/gitnexus-mcp.json — MCP config so the Claude action can
 *      call gitnexus_query / gitnexus_context / gitnexus_impact /
 *      gitnexus_api_impact during the review.
 *
 * All three are written to absolute paths under the runner workspace
 * so subsequent steps can reference them via step outputs.
 */

export interface RenderInputs {
  /** Workspace root — typically `process.env.GITHUB_WORKSPACE` or `process.cwd()`. */
  workspace: string;
  contextPack: ContextPack;
  hubUrl: string;
  token: string;
  repoFullName: string;
  prNumber: number;
}

export interface RenderResult {
  contextPackPath: string;
  systemPromptPath: string;
  mcpConfigPath: string;
}

export function renderArtifacts(opts: RenderInputs): RenderResult {
  const gitnexusDir = path.join(opts.workspace, '.gitnexus');
  const claudeDir = path.join(opts.workspace, '.claude');

  fs.mkdirSync(gitnexusDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });

  const contextPackPath = path.join(gitnexusDir, 'context-pack.json');
  const systemPromptPath = path.join(gitnexusDir, 'system-prompt.md');
  const mcpConfigPath = path.join(claudeDir, 'gitnexus-mcp.json');

  fs.writeFileSync(contextPackPath, JSON.stringify(opts.contextPack, null, 2), 'utf8');

  const promptTemplate = loadSystemPromptTemplate();
  const renderedPrompt = applyPlaceholders(promptTemplate, {
    CONTEXT_PACK_PATH: contextPackPath,
    HUB_URL: opts.hubUrl,
    REPO_FULL_NAME: opts.repoFullName,
    PR_NUMBER: String(opts.prNumber),
  });
  fs.writeFileSync(systemPromptPath, renderedPrompt, 'utf8');

  const mcpConfig = renderMcpConfig({ hubUrl: opts.hubUrl, token: opts.token });
  fs.writeFileSync(mcpConfigPath, mcpConfig, 'utf8');

  return { contextPackPath, systemPromptPath, mcpConfigPath };
}

/**
 * Substitute `{{KEY}}` markers in a template. Unknown markers are left
 * intact so a malformed template fails at review time (visible in
 * Claude's output) rather than silently dropping context.
 */
export function applyPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match;
  });
}

/**
 * Build the .claude/gitnexus-mcp.json content. The Claude action
 * accepts an HTTP MCP server config with a Bearer token in headers.
 *
 * We DO NOT inline the token in the system prompt — only here, in a
 * file that Claude's MCP transport reads at startup. The system prompt
 * stays scrub-safe for logs.
 */
export function renderMcpConfig(opts: { hubUrl: string; token: string }): string {
  const config = {
    mcpServers: {
      gitnexus: {
        type: 'http',
        url: `${opts.hubUrl.replace(/\/+$/, '')}/mcp`,
        headers: {
          Authorization: `Bearer ${opts.token}`,
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Locate and load the system-prompt template. ncc bundles src/main.ts
 * into dist/index.js but does NOT copy non-JS assets, so the build
 * script copies src/templates → dist/templates as a post-step. This
 * function tries both shapes (ncc-shipped path and unbundled-source
 * path) so vitest tests can run without a build.
 *
 * Override via `GITNEXUS_PROMPT_TEMPLATE_PATH` env var for tests that
 * want to inject a custom template.
 */
function loadSystemPromptTemplate(): string {
  const envOverride = process.env.GITNEXUS_PROMPT_TEMPLATE_PATH;
  if (envOverride && fs.existsSync(envOverride)) {
    return fs.readFileSync(envOverride, 'utf8');
  }
  const candidates = [
    // Bundled (ncc dist/templates/system-prompt.md, sibling to dist/index.js).
    path.join(__dirname, 'templates', 'system-prompt.md'),
    // Source tree fallback (running tests with tsx / vitest).
    path.join(__dirname, '..', 'src', 'templates', 'system-prompt.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  }
  throw new Error(
    `system-prompt template not found. Tried: ${candidates.join(', ')}. ` +
      `Set GITNEXUS_PROMPT_TEMPLATE_PATH to override.`,
  );
}
