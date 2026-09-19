import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

// Upstream opencode free tier (2026-09) validates requests against the real
// OpenCode CLI fingerprint:
//   - session ids must match ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
//     (12 lowercase hex + 14 base62); anything else → 403 FreeTierError
//     "OpenCode's free tier can only be used from within OpenCode"
//   - User-Agent must carry a version >= 1.18 (opencode/1.18.31 ...)
//   - x-opencode-client must be "cli"
//   - x-opencode-project must be a 40-hex random id
//   - body must stream (stream:true) and include the bash/glob/grep/read tools
const OPENCODE_UA = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomFrom(bytes, alphabet) {
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// Upstream-valid id: prefix + 12 lowercase hex + 14 base62 (26 chars total).
function generateCompliantId(prefix) {
  return `${prefix}${randomFrom(crypto.randomBytes(12), HEX)}${randomFrom(crypto.randomBytes(14), ALNUM)}`;
}

function generateRequestId() {
  return generateCompliantId("msg_");
}

function generateSessionId() {
  return generateCompliantId("ses_");
}

function generateProjectId() {
  return crypto.randomBytes(20).toString("hex"); // 40 hex chars
}

function isCompliant(value, re) {
  return typeof value === "string" && re.test(value);
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// OpenCode free tier is limited per egress IP — a 429/403 with a limit-ish
// body means the POOL's IP is exhausted, not the account. Declare it
// pool-scoped so chatCore marks the pool unfit, retries via another pool, and
// it shows up (clearable) on the Proxy Fitness page.
const IP_LIMIT_BODY = /limit|rate|quota|exhausted|capacity|too many|retry/i;

// ======================== Free-tier fingerprint ========================
// Upstream requires the four tools bash/glob/grep/read in the request body
// (only the names are checked; descriptions/schemas are arbitrary). Missing
// any of them triggers the same 403 FreeTierError.

const FREE_TOOLS_CHAT = [
  { type: "function", function: { name: "bash", description: "Run a shell command and return its output", parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to execute" } }, required: ["command"] } } },
  { type: "function", function: { name: "glob", description: "Find files matching a glob pattern", parameters: { type: "object", properties: { pattern: { type: "string", description: "The glob pattern to match files against" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep", description: "Search file contents with a regular expression", parameters: { type: "object", properties: { pattern: { type: "string", description: "The regular expression pattern to search for" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "read", description: "Read the contents of a file", parameters: { type: "object", properties: { file_path: { type: "string", description: "The path of the file to read" } }, required: ["file_path"] } } },
];

// Responses API shape for /zen/v1/responses models.
const FREE_TOOLS_RESPONSES = [
  { type: "function", name: "bash", description: "Run a shell command and return its output", parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to execute" } }, required: ["command"] } },
  { type: "function", name: "glob", description: "Find files matching a glob pattern", parameters: { type: "object", properties: { pattern: { type: "string", description: "The glob pattern to match files against" } }, required: ["pattern"] } },
  { type: "function", name: "grep", description: "Search file contents with a regular expression", parameters: { type: "object", properties: { pattern: { type: "string", description: "The regular expression pattern to search for" } }, required: ["pattern"] } },
  { type: "function", name: "read", description: "Read the contents of a file", parameters: { type: "object", properties: { file_path: { type: "string", description: "The path of the file to read" } }, required: ["file_path"] } },
];

function ensureFreeTierTools(body, tools) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const raw = Array.isArray(body.tools) ? body.tools : [];
  const existing = new Set();
  for (const t of raw) {
    const name = t?.function?.name || t?.name;
    if (typeof name === "string" && name) existing.add(name);
  }
  const missing = tools.filter(t => !existing.has(t.function?.name || t.name));
  if (missing.length > 0) body.tools = [...raw, ...missing];
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
    // Only upstream-valid ids are forwarded; a client-supplied session in any
    // other format would trip the 403 fingerprint gate.
    if (!isCompliant(this._currentSessionId, SESSION_RE)) {
      this._currentSessionId = generateSessionId();
    }

    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      // /zen/v1/responses fingerprint: streaming + four required tools.
      body.stream = true;
      ensureFreeTierTools(body, FREE_TOOLS_RESPONSES);
    } else {
      // /zen/v1/chat/completions fingerprint: streaming + four required tools
      // + usage in the stream.
      body.stream = true;
      ensureFreeTierTools(body, FREE_TOOLS_CHAT);
      if (body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options)) {
        body.stream_options.include_usage = true;
      } else {
        body.stream_options = { include_usage: true };
      }
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

    const session = isCompliant(lower["x-opencode-session"], SESSION_RE)
      ? lower["x-opencode-session"]
      : (this._currentSessionId || generateSessionId());
    const requestId = isCompliant(lower["x-opencode-request"], REQUEST_RE)
      ? lower["x-opencode-request"]
      : generateRequestId();

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "cli",
      "x-opencode-session": session,
      "x-session-id": lower["x-session-id"] || session,
      "x-session-affinity": lower["x-session-affinity"] || session,
      "x-opencode-request": requestId,
      "x-opencode-project": lower["x-opencode-project"] || generateProjectId(),
      "Accept": "application/json",
      "Accept-Encoding": "identity",
    };
  }

  parseError(response, bodyText) {
    const status = response?.status || 0;
    const text = String(bodyText || "");
    if ((status === 429 || status === 403) && IP_LIMIT_BODY.test(text)) {
      return {
        status,
        message: text.slice(0, 300) || `OpenCode free limit (${status})`,
        poolScoped: { reason: "ip-limit" },
      };
    }
    return null; // fall through to default parsing
  }
}