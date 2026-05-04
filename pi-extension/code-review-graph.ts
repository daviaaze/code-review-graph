/**
 * Code Review Graph Extension for Pi Agent
 *
 * Bridges pi's tool system to code-review-graph's MCP server via stdio.
 * Provides 27+ graph-aware tools for token-efficient code exploration.
 *
 * Installation:
 *   1. pip install code-review-graph
 *   2. cp code-review-graph.ts ~/.pi/agent/extensions/
 *   3. pi /reload
 *
 * The extension auto-starts the MCP server on session start and registers
 * all graph tools natively in pi's tool registry.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// MCP Protocol Types
// ---------------------------------------------------------------------------

interface McpRequest {
	jsonrpc: "2.0";
	id?: number;
	method: string;
	params?: unknown;
}

interface McpResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

class McpClient {
	private process: ChildProcessWithoutNullStreams | null = null;
	private requestId = 0;
	private pending = new Map<number, PendingRequest>();
	private buffer = "";
	private initialized = false;
	private tools: McpTool[] = [];
	private requestTimeout = 30000; // 30s default

	constructor(
		private command: string,
		private args: string[],
		private cwd: string,
	) {}

	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.process = spawn(this.command, this.args, {
				cwd: this.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PYTHONUNBUFFERED: "1" },
			});

			this.process.stdout.on("data", (data: Buffer) => {
				this.handleData(data.toString());
			});

			this.process.stderr.on("data", (data: Buffer) => {
				// Log stderr for debugging but don't fail
				const msg = data.toString().trim();
				if (msg && !msg.includes("INFO") && !msg.includes("DEBUG")) {
					console.error(`[code-review-graph] ${msg}`);
				}
			});

			this.process.on("error", (err) => {
				reject(new Error(`Failed to start code-review-graph: ${err.message}`));
			});

			this.process.on("close", (code) => {
				if (code !== 0 && code !== null) {
					console.error(`[code-review-graph] MCP server exited with code ${code}`);
				}
				this.cleanup();
			});

			// Wait a moment for server to be ready, then initialize
			setTimeout(async () => {
				try {
					await this.initialize();
					resolve();
				} catch (err) {
					reject(err);
				}
			}, 500);
		});
	}

	private async initialize(): Promise<void> {
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi-code-review-graph", version: "1.0.0" },
		});

		// MCP protocol requires sending initialized notification before other requests
		this.sendNotification("notifications/initialized", {});

		// Tools are not returned in initialize response; must fetch separately
		const listResult = (await this.request("tools/list", {})) as { tools?: McpTool[] };
		this.tools = listResult.tools ?? [];
		this.initialized = true;
	}

	private sendNotification(method: string, params?: unknown): void {
		if (!this.process || this.process.killed) return;
		const req: McpRequest = { jsonrpc: "2.0", method, params };
		this.process.stdin.write(JSON.stringify(req) + "\n");
	}

	private handleData(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as McpResponse;
				if (msg.id !== undefined) {
					const pending = this.pending.get(msg.id);
					if (pending) {
						this.pending.delete(msg.id);
						clearTimeout(pending.timer);
						if (msg.error) {
							pending.reject(new Error(msg.error.message));
						} else {
							pending.resolve(msg.result);
						}
					}
				}
			} catch {
				// Not JSON, ignore
			}
		}
	}

	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.process || this.process.killed) {
			throw new Error("MCP server not running");
		}

		const id = ++this.requestId;
		const req: McpRequest = { jsonrpc: "2.0", id, method, params };
		const reqLine = JSON.stringify(req) + "\n";

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request timeout: ${method}`));
			}, this.requestTimeout);

			this.pending.set(id, { resolve, reject, timer });
			this.process!.stdin.write(reqLine, (err) => {
				if (err) {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(err);
				}
			});
		});
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		// Server tool names have a "_tool" suffix (e.g. build_or_update_graph_tool)
		const mcpName = name.endsWith("_tool") ? name : `${name}_tool`;
		return this.request("tools/call", { name: mcpName, arguments: args });
	}

	getToolList(): McpTool[] {
		return this.tools;
	}

	isInitialized(): boolean {
		return this.initialized;
	}

	stop(): void {
		this.cleanup();
		if (this.process && !this.process.killed) {
			this.process.kill("SIGTERM");
			setTimeout(() => {
				if (this.process && !this.process.killed) {
					this.process.kill("SIGKILL");
				}
			}, 3000);
		}
	}

	private cleanup(): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("MCP server shut down"));
		}
		this.pending.clear();
	}
}

// ---------------------------------------------------------------------------
// Tool Parameter Schemas
// ---------------------------------------------------------------------------

const RepoRootParam = Type.Optional(
	Type.String({ description: "Repository root path. Auto-detected if omitted." }),
);

const BaseParam = Type.Optional(
	Type.String({ description: "Git ref for diff comparison (default: HEAD~1)", default: "HEAD~1" }),
);

const DetailLevelParam = StringEnum(["standard", "minimal"] as const, {
	description: "Output detail level",
	default: "standard",
});

// Tool 1: build_or_update_graph
const BuildParams = Type.Object({
	repo_root: RepoRootParam,
	postprocess: StringEnum(["none", "minimal", "full"] as const, {
		description: "Post-build processing level",
		default: "full",
	}),
	changed_files: Type.Optional(
		Type.Array(Type.String(), { description: "Explicit list of changed files for incremental update" }),
	),
});

// Tool 2: get_impact_radius
const ImpactRadiusParams = Type.Object({
	changed_files: Type.Optional(
		Type.Array(Type.String(), { description: "Explicit changed file paths (relative to repo root). Auto-detected from git if omitted." }),
	),
	max_depth: Type.Optional(Type.Integer({ description: "Traversal depth (default: 2)", default: 2 })),
	max_results: Type.Optional(Type.Integer({ description: "Max impacted nodes (default: 500)", default: 500 })),
	repo_root: RepoRootParam,
	base: BaseParam,
	detail_level: DetailLevelParam,
});

// Tool 3: query_graph
const QueryPatternParam = StringEnum(
	[
		"callers_of",
		"callees_of",
		"imports_of",
		"importers_of",
		"children_of",
		"tests_for",
		"inheritors_of",
		"file_summary",
	] as const,
	{ description: "Query pattern" },
);

const QueryGraphParams = Type.Object({
	pattern: QueryPatternParam,
	target: Type.String({ description: "Target name or qualified name to query" }),
	repo_root: RepoRootParam,
	max_results: Type.Optional(Type.Integer({ description: "Max results (default: 100)", default: 100 })),
});

// Tool 4: get_review_context
const ReviewContextParams = Type.Object({
	changed_files: Type.Optional(Type.Array(Type.String())),
	max_depth: Type.Optional(Type.Integer({ default: 2 })),
	include_source: Type.Optional(Type.Boolean({ default: true })),
	max_lines_per_file: Type.Optional(Type.Integer({ default: 200 })),
	repo_root: RepoRootParam,
	base: BaseParam,
	detail_level: DetailLevelParam,
});

// Tool 5: semantic_search_nodes
const SemanticSearchParams = Type.Object({
	query: Type.String({ description: "Search query (keyword or natural language)" }),
	kind: Type.Optional(Type.String({ description: "Filter by node kind (e.g. Function, Class)" })),
	limit: Type.Optional(Type.Integer({ description: "Max results (default: 20)", default: 20 })),
	repo_root: RepoRootParam,
	use_embeddings: Type.Optional(Type.Boolean({ description: "Use vector search if available", default: true })),
});

// Tool 6: list_graph_stats
const GraphStatsParams = Type.Object({
	repo_root: RepoRootParam,
});

// Tool 7: embed_graph
const EmbedGraphParams = Type.Object({
	repo_root: RepoRootParam,
	model: Type.Optional(Type.String({ description: "Embedding model name" })),
	provider: Type.Optional(
		Type.String({ description: "Provider: local, openai, google, minimax", default: "local" }),
	),
});

// Tool 8: get_docs_section
const DocsSectionParams = Type.Object({
	section_name: Type.String({
		description: "Section name: usage, review-delta, review-pr, commands, legal, watch, embeddings, languages, troubleshooting",
	}),
	repo_root: RepoRootParam,
});

// Tool 9: find_large_functions
const LargeFunctionsParams = Type.Object({
	max_lines: Type.Optional(Type.Integer({ description: "Line threshold (default: 50)", default: 50 })),
	repo_root: RepoRootParam,
	limit: Type.Optional(Type.Integer({ description: "Max results (default: 20)", default: 20 })),
});

// Tool 10: list_flows
const ListFlowsParams = Type.Object({
	repo_root: RepoRootParam,
	sort_by: Type.Optional(
		Type.String({ description: "Sort: criticality, depth, node_count, file_count, name", default: "criticality" }),
	),
	limit: Type.Optional(Type.Integer({ default: 50 })),
	kind: Type.Optional(Type.String({ description: "Filter by entry point kind" })),
	detail_level: DetailLevelParam,
});

// Tool 11: get_flow
const GetFlowParams = Type.Object({
	flow_id: Type.Optional(Type.Integer()),
	flow_name: Type.Optional(Type.String()),
	include_source: Type.Optional(Type.Boolean({ default: false })),
	repo_root: RepoRootParam,
});

// Tool 12: get_affected_flows
const AffectedFlowsParams = Type.Object({
	changed_files: Type.Optional(Type.Array(Type.String())),
	repo_root: RepoRootParam,
	base: BaseParam,
});

// Tool 13: list_communities
const ListCommunitiesParams = Type.Object({
	repo_root: RepoRootParam,
	sort_by: Type.Optional(Type.String({ default: "size" })),
	min_size: Type.Optional(Type.Integer({ default: 0 })),
	detail_level: DetailLevelParam,
});

// Tool 14: get_community
const GetCommunityParams = Type.Object({
	community_name: Type.Optional(Type.String()),
	community_id: Type.Optional(Type.Integer()),
	include_members: Type.Optional(Type.Boolean({ default: false })),
	repo_root: RepoRootParam,
});

// Tool 15: get_architecture_overview
const ArchitectureOverviewParams = Type.Object({
	repo_root: RepoRootParam,
});

// Tool 16: detect_changes
const DetectChangesParams = Type.Object({
	changed_files: Type.Optional(Type.Array(Type.String())),
	repo_root: RepoRootParam,
	base: BaseParam,
	detail_level: DetailLevelParam,
});

// Tool 17: refactor_tool
const RefactorParams = Type.Object({
	mode: StringEnum(["rename", "dead_code", "suggest"] as const, { default: "suggest" }),
	old_name: Type.Optional(Type.String({ description: "Current symbol name (rename mode)" })),
	new_name: Type.Optional(Type.String({ description: "Desired new name (rename mode)" })),
	kind: Type.Optional(Type.String({ description: "Node kind filter (dead_code mode)" })),
	file_pattern: Type.Optional(Type.String({ description: "File path substring filter (dead_code mode)" })),
	repo_root: RepoRootParam,
});

// Tool 18: apply_refactor_tool
const ApplyRefactorParams = Type.Object({
	refactor_id: Type.String({ description: "Refactor ID from refactor_tool preview" }),
	repo_root: RepoRootParam,
});

// Tool 19: generate_wiki
const GenerateWikiParams = Type.Object({
	repo_root: RepoRootParam,
	output_dir: Type.Optional(Type.String({ description: "Output directory for wiki files" })),
});

// Tool 20: get_wiki_page
const GetWikiPageParams = Type.Object({
	page_name: Type.String({ description: "Wiki page name" }),
	repo_root: RepoRootParam,
});

// Tool 21: list_repos
const ListReposParams = Type.Object({});

// Tool 22: cross_repo_search
const CrossRepoSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	kind: Type.Optional(Type.String({ description: "Node kind filter" })),
	limit: Type.Optional(Type.Integer({ default: 20 })),
});

// Tool 23: get_hub_nodes
const HubNodesParams = Type.Object({
	repo_root: RepoRootParam,
	top_n: Type.Optional(Type.Integer({ default: 10 })),
});

// Tool 24: get_bridge_nodes
const BridgeNodesParams = Type.Object({
	repo_root: RepoRootParam,
	top_n: Type.Optional(Type.Integer({ default: 10 })),
});

// Tool 25: get_knowledge_gaps
const KnowledgeGapsParams = Type.Object({
	repo_root: RepoRootParam,
});

// Tool 26: get_surprising_connections
const SurprisingConnectionsParams = Type.Object({
	repo_root: RepoRootParam,
	top_n: Type.Optional(Type.Integer({ default: 15 })),
});

// Tool 27: get_suggested_questions
const SuggestedQuestionsParams = Type.Object({
	repo_root: RepoRootParam,
	changed_files: Type.Optional(Type.Array(Type.String())),
});

// Tool 28: traverse_graph
const TraverseGraphParams = Type.Object({
	start_node: Type.String({ description: "Starting node name or qualified name" }),
	method: StringEnum(["bfs", "dfs"] as const, { default: "bfs" }),
	max_depth: Type.Optional(Type.Integer({ default: 3 })),
	edge_kinds: Type.Optional(Type.Array(Type.String(), { description: "Filter by edge kinds (e.g. CALLS, IMPORTS)" })),
	repo_root: RepoRootParam,
});

// ---------------------------------------------------------------------------
// Result Formatting
// ---------------------------------------------------------------------------

function formatResult(result: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
	if (result === null || result === undefined) {
		return { content: [{ type: "text", text: "(no result)" }], details: result };
	}

	if (typeof result === "string") {
		return { content: [{ type: "text", text: result }], details: result };
	}

	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;

		// Extract summary if present
		const summary = obj.summary ?? obj.status ?? "";
		const text = typeof summary === "string" ? summary : JSON.stringify(summary, null, 2);

		// Build full JSON output for LLM context
		const fullJson = JSON.stringify(result, null, 2);

		return {
			content: [{ type: "text", text: fullJson }],
			details: result,
		};
	}

	return {
		content: [{ type: "text", text: String(result) }],
		details: result,
	};
}

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let client: McpClient | null = null;
	let isAvailable = false;

	// Find code-review-graph executable
	function findExecutable(): { command: string; args: string[] } | null {
		// Check NIX_STORE_PATHS environment variable for Nix-installed binary
		const nixStorePaths = process.env.NIX_STORE_PATHS;
		if (nixStorePaths) {
			const paths = nixStorePaths.split(":");
			for (const storePath of paths) {
				const binPath = resolve(storePath, "bin", "code-review-graph");
				if (existsSync(binPath)) {
					return { command: binPath, args: ["serve"] };
				}
			}
		}

		// Try PATH resolution first
		try {
			const { execSync } = require("node:child_process");
			const path = execSync("which code-review-graph", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
			if (path) {
				return { command: path, args: ["serve"] };
			}
		} catch {
			// Not in PATH
		}

		// Try uvx (preferred for non-Nix installs)
		try {
			const { execSync } = require("node:child_process");
			execSync("which uvx", { stdio: "ignore" });
			return { command: "uvx", args: ["code-review-graph", "serve"] };
		} catch {
			// uvx not available
		}

		// Try common installation paths
		const candidates = [
			resolve(process.env.HOME ?? "", ".local/bin/code-review-graph"),
			"/usr/local/bin/code-review-graph",
			"/usr/bin/code-review-graph",
			"/run/current-system/sw/bin/code-review-graph",
		];
		for (const path of candidates) {
			if (existsSync(path)) {
				return { command: path, args: ["serve"] };
			}
		}

		return null;
	}

	// Register all tools with a helper
	function registerGraphTool(
		name: string,
		label: string,
		description: string,
		promptSnippet: string,
		promptGuidelines: string[],
		parameters: ReturnType<typeof Type.Object>,
	) {
		pi.registerTool({
			name,
			label,
			description,
			promptSnippet,
			promptGuidelines,
			parameters,
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				if (!client || !client.isInitialized()) {
					throw new Error("code-review-graph MCP server not available. Run: pip install code-review-graph && code-review-graph build");
				}
				const result = await client.callTool(name, params as Record<string, unknown>);
				return formatResult(result);
			},
		});
	}

	// ── Session Lifecycle ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const exec = findExecutable();
		if (!exec) {
			ctx.ui.notify("code-review-graph not found. Install: pip install code-review-graph", "warning");
			return;
		}

		try {
			client = new McpClient(exec.command, exec.args, ctx.cwd);
			await client.start();
			isAvailable = true;

			const toolCount = client.getToolList().length;
			ctx.ui.notify(`code-review-graph connected (${toolCount} tools)`, "success");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`code-review-graph failed: ${msg}`, "error");
			isAvailable = false;
		}
	});

	pi.on("session_shutdown", async () => {
		if (client) {
			client.stop();
			client = null;
		}
		isAvailable = false;
	});

	// ── Register All Graph Tools ────────────────────────────────────────────

	// [BUILD] Tool 1: build_or_update_graph
	registerGraphTool(
		"build_or_update_graph",
		"Build Graph",
		"Build or incrementally update the code review knowledge graph. Run this first when working with a new or changed codebase.",
		"Build or update the code review graph for the current project",
		[
			"Use build_or_update_graph when starting work on a project without a graph, or after significant changes.",
			"Use build_or_update_graph with changed_files for faster incremental updates.",
		],
		BuildParams,
	);

	// [ANALYSIS] Tool 2: get_impact_radius
	registerGraphTool(
		"get_impact_radius",
		"Impact Radius",
		"Analyze the blast radius of changed files. Returns changed nodes, impacted nodes, impacted files, and connecting edges.",
		"Find all code affected by recent changes (blast radius analysis)",
		[
			"Use get_impact_radius BEFORE reading files to understand what needs review.",
			"Use get_impact_radius with detail_level='minimal' for a quick risk assessment.",
			"Always check get_impact_radius before making changes to understand downstream effects.",
		],
		ImpactRadiusParams,
	);

	// [QUERY] Tool 3: query_graph
	registerGraphTool(
		"query_graph",
		"Query Graph",
		"Run predefined graph queries: callers_of, callees_of, imports_of, importers_of, children_of, tests_for, inheritors_of, file_summary.",
		"Find callers, callees, imports, tests, or inheritance for a symbol",
		[
			"Use query_graph callers_of to find what calls a function before modifying it.",
			"Use query_graph tests_for to check test coverage for a function or class.",
			"Use query_graph inheritors_of before refactoring base classes.",
			"Use query_graph imports_of to understand module dependencies.",
		],
		QueryGraphParams,
	);

	// [REVIEW] Tool 4: get_review_context
	registerGraphTool(
		"get_review_context",
		"Review Context",
		"Generate focused review context from changed files: subgraph, source snippets, and review guidance. Token-optimized for code review.",
		"Get focused review context for changed files with source snippets",
		[
			"Use get_review_context for PR reviews instead of reading entire files.",
			"Use get_review_context with detail_level='minimal' for a quick risk summary.",
		],
		ReviewContextParams,
	);

	// [SEARCH] Tool 5: semantic_search_nodes
	registerGraphTool(
		"semantic_search_nodes",
		"Semantic Search",
		"Search graph nodes by keyword or vector similarity. Finds functions, classes, and other symbols.",
		"Search for functions, classes, or symbols by name or description",
		[
			"Use semantic_search_nodes instead of grep when looking for symbols by meaning, not just text.",
			"Use semantic_search_nodes with kind='Function' to find specific function types.",
		],
		SemanticSearchParams,
	);

	// [STATS] Tool 6: list_graph_stats
	registerGraphTool(
		"list_graph_stats",
		"Graph Stats",
		"Get aggregate statistics about the knowledge graph: node counts, edge counts, languages, coverage.",
		"Show graph statistics and codebase overview",
		[
			"Use list_graph_stats to verify the graph is built and see codebase scale.",
		],
		GraphStatsParams,
	);

	// [EMBEDDINGS] Tool 7: embed_graph
	registerGraphTool(
		"embed_graph",
		"Embed Graph",
		"Compute vector embeddings for semantic search. Requires sentence-transformers or API keys for cloud providers.",
		"Enable semantic search by computing vector embeddings",
		[
			"Use embed_graph once after build to enable vector-based semantic_search_nodes.",
		],
		EmbedGraphParams,
	);

	// [DOCS] Tool 8: get_docs_section
	registerGraphTool(
		"get_docs_section",
		"Docs Section",
		"Retrieve a specific documentation section (usage, review-delta, review-pr, commands, etc.)",
		"Get a specific documentation section",
		["Use get_docs_section for reference material about code-review-graph features."],
		DocsSectionParams,
	);

	// [ANALYSIS] Tool 9: find_large_functions
	registerGraphTool(
		"find_large_functions",
		"Large Functions",
		"Find oversized functions and classes by line count. Identifies refactoring candidates.",
		"Find functions or classes that are too large",
		["Use find_large_functions to identify functions that may need decomposition."],
		LargeFunctionsParams,
	);

	// [FLOWS] Tool 10: list_flows
	registerGraphTool(
		"list_flows",
		"List Flows",
		"List execution flows sorted by criticality. Each flow is a call chain from an entry point.",
		"List execution flows (call chains from entry points)",
		[
			"Use list_flows to understand the most critical execution paths in the codebase.",
			"Use list_flows with kind='Test' to find test entry points.",
		],
		ListFlowsParams,
	);

	// [FLOWS] Tool 11: get_flow
	registerGraphTool(
		"get_flow",
		"Get Flow",
		"Get details of a single execution flow, including each step's function, file, and line numbers.",
		"Get details of a specific execution flow",
		["Use get_flow after list_flows to inspect a specific critical path."],
		GetFlowParams,
	);

	// [FLOWS] Tool 12: get_affected_flows
	registerGraphTool(
		"get_affected_flows",
		"Affected Flows",
		"Find execution flows affected by changed files. Shows which critical paths are impacted by a change.",
		"Find execution flows affected by recent changes",
		[
			"Use get_affected_flows after detect_changes to see which critical paths are at risk.",
		],
		AffectedFlowsParams,
	);

	// [COMMUNITIES] Tool 13: list_communities
	registerGraphTool(
		"list_communities",
		"List Communities",
		"List detected code communities (clusters of related code via Leiden algorithm or file grouping).",
		"List code communities/clusters in the codebase",
		["Use list_communities to understand the modular structure of the codebase."],
		ListCommunitiesParams,
	);

	// [COMMUNITIES] Tool 14: get_community
	registerGraphTool(
		"get_community",
		"Get Community",
		"Get details of a single code community, optionally with full member list.",
		"Get details of a specific code community",
		["Use get_community after list_communities to inspect a cluster's members."],
		GetCommunityParams,
	);

	// [COMMUNITIES] Tool 15: get_architecture_overview
	registerGraphTool(
		"get_architecture_overview",
		"Architecture Overview",
		"Get a high-level architecture overview from community structure. Summarizes the codebase organization.",
		"Get high-level architecture overview of the codebase",
		[
			"Use get_architecture_overview when first exploring a codebase to understand its structure.",
		],
		ArchitectureOverviewParams,
	);

	// [REVIEW] Tool 16: detect_changes
	registerGraphTool(
		"detect_changes",
		"Detect Changes",
		"Risk-scored change impact analysis. Detects changed files, analyzes risk, finds test gaps, and suggests review focus.",
		"Analyze code changes with risk scoring for review",
		[
			"Use detect_changes as the FIRST step in any code review workflow.",
			"Use detect_changes to get a risk score and identify test gaps before reviewing.",
		],
		DetectChangesParams,
	);

	// [REFACTOR] Tool 17: refactor_tool
	registerGraphTool(
		"refactor_tool",
		"Refactor",
		"Unified refactoring: rename preview, dead code detection, or community-driven suggestions.",
		"Preview renames, find dead code, or get refactoring suggestions",
		[
			"Use refactor_tool with mode='dead_code' to find unreferenced symbols.",
			"Use refactor_tool with mode='rename' to preview a rename before applying.",
		],
		RefactorParams,
	);

	// [REFACTOR] Tool 18: apply_refactor_tool
	registerGraphTool(
		"apply_refactor_tool",
		"Apply Refactor",
		"Apply a previously previewed refactoring from refactor_tool.",
		"Apply a previewed refactoring",
		["Use apply_refactor_tool after refactor_tool preview to execute the changes."],
		ApplyRefactorParams,
	);

	// [WIKI] Tool 19: generate_wiki
	registerGraphTool(
		"generate_wiki",
		"Generate Wiki",
		"Generate markdown wiki from community structure.",
		"Generate a wiki from the codebase graph",
		["Use generate_wiki to create documentation from the code structure."],
		GenerateWikiParams,
	);

	// [WIKI] Tool 20: get_wiki_page
	registerGraphTool(
		"get_wiki_page",
		"Wiki Page",
		"Retrieve a specific wiki page.",
		"Get a specific wiki page",
		["Use get_wiki_page after generate_wiki to read generated documentation."],
		GetWikiPageParams,
	);

	// [REGISTRY] Tool 21: list_repos
	registerGraphTool(
		"list_repos",
		"List Repos",
		"List all registered repositories in the global multi-repo registry.",
		"List registered repositories",
		["Use list_repos to see all projects tracked by code-review-graph."],
		ListReposParams,
	);

	// [REGISTRY] Tool 22: cross_repo_search
	registerGraphTool(
		"cross_repo_search",
		"Cross-Repo Search",
		"Search across all registered repositories.",
		"Search across all registered repositories",
		["Use cross_repo_search to find symbols across multiple projects."],
		CrossRepoSearchParams,
	);

	// [ANALYSIS] Tool 23: get_hub_nodes
	registerGraphTool(
		"get_hub_nodes",
		"Hub Nodes",
		"Find the most connected nodes (architectural hotspots). Changes to these have disproportionate blast radius.",
		"Find the most connected/architecturally critical nodes",
		[
			"Use get_hub_nodes to identify architectural hotspots that need careful review.",
			"Use get_hub_nodes before refactoring to understand high-impact symbols.",
		],
		HubNodesParams,
	);

	// [ANALYSIS] Tool 24: get_bridge_nodes
	registerGraphTool(
		"get_bridge_nodes",
		"Bridge Nodes",
		"Find architectural chokepoints via betweenness centrality. If these break, multiple regions lose connectivity.",
		"Find architectural chokepoints (bridge nodes)",
		[
			"Use get_bridge_nodes to find single points of failure in the architecture.",
		],
		BridgeNodesParams,
	);

	// [ANALYSIS] Tool 25: get_knowledge_gaps
	registerGraphTool(
		"get_knowledge_gaps",
		"Knowledge Gaps",
		"Identify structural weaknesses: isolated nodes, thin communities, untested hotspots, single-file communities.",
		"Find structural weaknesses and knowledge gaps",
		["Use get_knowledge_gaps to find areas of the codebase that need attention."],
		KnowledgeGapsParams,
	);

	// [ANALYSIS] Tool 26: get_surprising_connections
	registerGraphTool(
		"get_surprising_connections",
		"Surprising Connections",
		"Find unexpected architectural coupling (cross-community, cross-language, peripheral-to-hub connections).",
		"Find unexpected coupling between code regions",
		["Use get_surprising_connections to spot architectural violations or hidden dependencies."],
		SurprisingConnectionsParams,
	);

	// [ANALYSIS] Tool 27: get_suggested_questions
	registerGraphTool(
		"get_suggested_questions",
		"Suggested Questions",
		"Auto-generated review questions from graph analysis.",
		"Get auto-generated review questions",
		["Use get_suggested_questions to get prompts for thorough code review."],
		SuggestedQuestionsParams,
	);

	// [TRAVERSE] Tool 28: traverse_graph
	registerGraphTool(
		"traverse_graph",
		"Traverse Graph",
		"BFS/DFS traversal from a best-matching node. Explore the graph neighborhood of a symbol.",
		"Traverse the graph from a starting node (BFS/DFS)",
		["Use traverse_graph to explore the neighborhood of a symbol beyond direct callers/callees."],
		TraverseGraphParams,
	);

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("crg-status", {
		description: "Show code-review-graph connection status",
		handler: async (_args, ctx) => {
			if (isAvailable && client?.isInitialized()) {
				const toolCount = client.getToolList().length;
				ctx.ui.notify(`code-review-graph: connected (${toolCount} tools available)`, "success");
			} else {
				ctx.ui.notify("code-review-graph: not connected. Install with: pip install code-review-graph", "warning");
			}
		},
	});

	pi.registerCommand("crg-build", {
		description: "Build or update the code review graph",
		handler: async (_args, ctx) => {
			if (!isAvailable || !client) {
				ctx.ui.notify("code-review-graph not connected", "error");
				return;
			}
			try {
				ctx.ui.notify("Building code review graph...", "info");
				const result = await client.callTool("build_or_update_graph", {});
				const summary = (result as Record<string, unknown>)?.summary ?? "Build complete";
				ctx.ui.notify(String(summary), "success");
			} catch (err) {
				ctx.ui.notify(`Build failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// ── System Prompt Enhancement ───────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!isAvailable) return {};

		const graphGuidelines = `
## Code Review Graph Guidelines

This project has a code-review-graph knowledge graph available. ALWAYS prefer graph tools over file scanning:

1. **Before exploring**: Use semantic_search_nodes or query_graph instead of grep/find
2. **Before reviewing**: Use detect_changes + get_review_context instead of reading entire files
3. **Before modifying**: Use get_impact_radius to understand blast radius
4. **For architecture**: Use get_architecture_overview + list_communities
5. **For testing**: Use query_graph with pattern="tests_for" to check coverage

Workflow:
- Start with build_or_update_graph if unsure if graph is current
- Use detect_changes for any review task
- Use get_impact_radius to find affected code
- Use query_graph callers_of/callees_of for dependency tracing
- Fall back to read/bash ONLY when graph tools don't cover the need
`;

		return {
			systemPrompt: event.systemPrompt + graphGuidelines,
		};
	});
}
