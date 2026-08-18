// Obsidian Vault Ease of Maintenance Plugin
// All-in-plugin GraphRAG indexer + LLM-driven agents.
// Path C: No server, no Python, no Docker — runs entirely inside Obsidian.
//
// Clean/sort/chat reviews render through the shared ReviewCore into one of
// two interchangeable containers — a docked right sidebar pane (default) or
// a centered modal overlay — chosen in the plugin settings.

import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import { updateSettings, settings, INDEX_DB_SUFFIX, CONFIG_FILENAME } from "./src/config";
import { parseConfigYaml, mergeConfigLayers } from "./src/config-yaml";
import { errorMessage } from "./src/errors";
import { detectToolCallSupport, probeConnection } from "./src/agent/capability";
import { closeChatSession } from "./src/agent/chat_session";
import {
  runCleanup,
  runTriage,
  runBuild,
  runChatQuery,
  ProposedChange,
} from "./src/agent/runtime";
import { VaultIO } from "./src/io/vault_io";
import { setDefaultDbHost, createObsidianDbHost } from "./src/indexer/db_host";
import { resetRegistry } from "./src/agent/tools";
import { openReviewInModal } from "./src/container-modal";
import {
  openReviewInSidebar,
  REVIEW_VIEW_TYPE,
  ReviewView,
} from "./src/container-sidebar";
import type { ReviewSpec, SortResultPayload } from "./src/types";

// ---------------------------------------------------------------------------
// Plugin Settings
// ---------------------------------------------------------------------------

type ReviewContainer = "sidebar" | "modal";

interface PluginSettings {
  apiKey: string;
  apiBaseUrl: string;
  agentModel: string;
  embeddingModel: string;
  // Embedding dimensions come from config (config.yaml → embedding.dimensions,
  // overridable in the Settings tab). 0 = unknown (legacy fallback applies).
  embeddingDimensions: number;
  // Per-feature reasoning gate — config.yaml agent.thinking.{chat,build,sort}
  // (overridable in the Settings tab). Reasoning models (gemma-4-31b-it)
  // think before answering; off by default (measured: no quality gain).
  agentThinkingChat: boolean;
  agentThinkingBuild: boolean;
  agentThinkingSort: boolean;
  inboxFolder: string;
  ignorePatterns: string;
  manifestFilename: string;
  reviewContainer: ReviewContainer;
  // Index-size warning threshold (MB) — config.yaml index.warn_mb; when the
  // exported index exceeds it, DatabaseManager warns (sql.js builds hold ~10×
  // the file size in RAM).
  indexWarnMb: number;
  // GraphRAG tuning — config.yaml query: + graph: + reports: sections
  // (single source of truth; deliberately NOT in the Settings tab —
  // advanced tuning).
  queryTopK: number;
  queryDepth: number;
  queryMaxFanOut: number;
  queryMaxSeeds: number;
  queryTopReports: number;
  graphClusterThreshold: number;
  graphInferredThreshold: number;
  graphInferredMaxEdgesPerSection: number;
  reportsContextCapTokens: number;
  extractionContextCapTokens: number;
}

const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1",
  agentModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 0,
  agentThinkingChat: false,
  agentThinkingBuild: false,
  agentThinkingSort: false,
  inboxFolder: "",
  ignorePatterns: "",
  manifestFilename: "_manifest.md",
  reviewContainer: "sidebar",
  indexWarnMb: 256,
  queryTopK: 5,
  queryDepth: 1,
  queryMaxFanOut: 8,
  queryMaxSeeds: 8,
  queryTopReports: 3,
  graphClusterThreshold: 0.5,
  graphInferredThreshold: 0.7,
  graphInferredMaxEdgesPerSection: 3,
  reportsContextCapTokens: 3000,
  extractionContextCapTokens: 3000,
};

// Unique ids for clean/sort review specs (ReviewCore dedupes by spec key).
let reviewSeq = 0;

// Embedding dimensions come from config (config.yaml → embedding.dimensions,
// overridable in the Settings tab). The legacy name-based inference
// (1536/3072) is only a last-resort fallback when no dimension was set.
function resolveEmbeddingDimensions(model: string, configured: number): number {
  if (configured > 0) return configured;
  return model.includes("large") ? 3072 : 1536;
}

// ---------------------------------------------------------------------------
// Setting Tab — metadata-driven dual-path rendering
// ---------------------------------------------------------------------------
// One SETTING_META table drives both rendering paths so the two surfaces
// cannot drift: the declarative getSettingDefinitions() (Obsidian 1.13.0+
// settings search) and the imperative display() (Obsidian < 1.13.0).

interface SettingMetaBase {
  name: string;
  desc: string;
  placeholder?: string;
  buttonText?: string;
}

/** A value-bearing setting — stores one PluginSettings key. */
interface SettingValueMeta extends SettingMetaBase {
  kind: "text" | "textarea" | "dropdown";
  key: keyof PluginSettings;
  rows?: number;
  options?: Record<string, string>;
}

/** An action row — runs a handler on click, stores nothing (no key). */
interface SettingButtonMeta extends SettingMetaBase {
  kind: "button";
  buttonText: string;
}

type SettingMeta = SettingValueMeta | SettingButtonMeta;

const SETTING_META: SettingMeta[] = [
  {
    kind: "dropdown",
    key: "reviewContainer",
    name: "Review container",
    desc: "Where clean/sort reviews and chat open: a docked sidebar pane or a centered modal overlay.",
    options: { sidebar: "Sidebar pane", modal: "Modal overlay" },
  },
  {
    kind: "text",
    key: "apiKey",
    name: "API key",
    desc: "API key for the OpenAI-compatible API. Save a copy somewhere safe — it may be erased when the plugin updates.",
    placeholder: "Sk-...",
  },
  {
    kind: "text",
    key: "apiBaseUrl",
    name: "API base URL",
    desc: "Base URL for the OpenAI-compatible API.",
    placeholder: "https://api.openai.com/v1",
  },
  {
    kind: "text",
    key: "agentModel",
    name: "Reasoning model",
    desc: "Model for cleanup, sort, and chat agents (e.g. a reasoning model like gemma-4-31b-it).",
    placeholder: "gpt-4o-mini",
  },
  {
    kind: "text",
    key: "embeddingModel",
    name: "Embedding model",
    desc: "Model for text embeddings.",
    placeholder: "text-embedding-3-small",
  },
  {
    kind: "button",
    name: "Test connection",
    desc: "Ping the configured API (the same probe chat's tool-call detection uses) to confirm the API key and base URL are reachable.",
    buttonText: "Test connection",
  },
  {
    kind: "text",
    key: "inboxFolder",
    name: "Inbox folder",
    desc: "Folder name for inbox triage (leave empty for auto-discover).",
    placeholder: "Inbox",
  },
  {
    kind: "textarea",
    key: "ignorePatterns",
    name: "Ignore patterns",
    desc: "One glob pattern per line. The plugin skips matching files and folders during indexing and sorting.",
    placeholder: "archive/\n*.bak",
    rows: 5,
  },
  {
    kind: "text",
    key: "manifestFilename",
    name: "Manifest filename",
    desc: "Name of the vault manifest file (default: _manifest.md).",
    placeholder: "_manifest.md",
  },
];

// Single write path for both renderers: normalize, store, persist, apply.
function normalizeSettingValue(key: keyof PluginSettings, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (key) {
    case "apiKey":
    case "apiBaseUrl":
    case "agentModel":
    case "embeddingModel":
    case "inboxFolder":
      return value.trim();
    case "manifestFilename":
      return value.trim() || "_manifest.md";
    default:
      return value;
  }
}

class VaultMaintenanceSettingTab extends PluginSettingTab {
  plugin: VaultMaintenancePlugin;

  constructor(app: App, plugin: VaultMaintenancePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian < 1.13.0 rendering path (getSettingDefinitions is 1.13.0+).
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Vault maintenance").setHeading();

    for (const meta of SETTING_META) {
      this.renderImperativeSetting(containerEl, meta);
    }
  }

  // Obsidian 1.13.0+ declarative path: renders the tab and indexes it for
  // settings search (display() is skipped when this returns non-empty).
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "Vault maintenance",
        items: SETTING_META.map((meta) => this.toSettingDefinition(meta)),
      },
    ];
  }

  // Reads from pluginSettings (base class reads this.plugin.settings).
  getControlValue(key: string): unknown {
    return (this.plugin.pluginSettings as unknown as Record<string, unknown>)[key];
  }

  // Single write path for both renderers — normalize, store, persist, apply.
  setControlValue(key: string, value: unknown): void {
    const settingKey = key as keyof PluginSettings;
    (this.plugin.pluginSettings as unknown as Record<string, unknown>)[settingKey] =
      normalizeSettingValue(settingKey, value);
    void this.plugin.saveSettings();
    this.applySettings();
  }

  private renderImperativeSetting(containerEl: HTMLElement, meta: SettingMeta): void {
    const setting = new Setting(containerEl).setName(meta.name).setDesc(meta.desc);

    if (meta.kind === "button") {
      setting.addButton((button) => {
        button.setButtonText(meta.buttonText);
        button.onClick(() => {
          void this.testConnection(button.buttonEl, meta.buttonText);
        });
      });
      return;
    }

    const currentValue = this.plugin.pluginSettings[meta.key];

    if (meta.kind === "dropdown") {
      setting.addDropdown((dropdown) => {
        for (const [optionValue, optionLabel] of Object.entries(meta.options ?? {})) {
          dropdown.addOption(optionValue, optionLabel);
        }
        dropdown
          .setValue(String(currentValue))
          .onChange((newValue) => this.setControlValue(meta.key, newValue));
      });
      return;
    }

    if (meta.kind === "textarea") {
      setting.addTextArea((text) => {
        text
          .setPlaceholder(meta.placeholder ?? "")
          .setValue(String(currentValue))
          .onChange((newValue) => this.setControlValue(meta.key, newValue));
        text.inputEl.rows = meta.rows ?? 3;
      });
      return;
    }

    setting.addText((text) => {
      text
        .setPlaceholder(meta.placeholder ?? "")
        .setValue(String(currentValue))
        .onChange((newValue) => this.setControlValue(meta.key, newValue));
    });
  }

  private toSettingDefinition(meta: SettingMeta): SettingDefinition {
    const base = { name: meta.name, desc: meta.desc };
    if (meta.kind === "dropdown") {
      return {
        ...base,
        control: {
          type: "dropdown",
          key: meta.key,
          options: meta.options ?? {},
        },
      };
    }
    if (meta.kind === "textarea") {
      return {
        ...base,
        control: {
          type: "textarea",
          key: meta.key,
          placeholder: meta.placeholder,
          rows: meta.rows,
        },
      };
    }
    if (meta.kind === "button") {
      // SettingDefinitionAction — a clickable row, no stored value.
      return {
        ...base,
        action: (el) => {
          const buttonEl = el.querySelector("button");
          void this.testConnection(buttonEl, meta.buttonText);
        },
      };
    }
    return {
      ...base,
      control: {
        type: "text",
        key: meta.key,
        placeholder: meta.placeholder,
      },
    };
  }

  // "Test connection" button handler — runs the shared probe
  // (capability.probeConnection): the same ping chat's tool-call detection
  // uses. Success surfaces the tool-call outcome (chat capability); failure
  // tells the user to check their API key and base URL (the technical detail
  // goes to the console). The button is disabled + shows "Testing…" while
  // the probe is in flight (retries can take several seconds).
  private async testConnection(
    buttonEl: HTMLButtonElement | null,
    restoreText: string,
  ): Promise<void> {
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = "Testing…";
    }
    try {
      const result = await probeConnection();
      if (result.connected) {
        new Notice(
          result.toolCalls
            ? "Connection OK — API responded; tool calling supported."
            : "Connection OK — API responded; this model can't call tools (chat uses retrieval fallback).",
        );
      } else {
        console.warn(`[settings] Connection test failed: ${result.error}`);
        new Notice("Connection error — check your API key and base URL.", 10000);
      }
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = restoreText;
      }
    }
  }

  applySettings(): void {
    const s = this.plugin.pluginSettings;
    updateSettings({
      api: {
        apiKey: s.apiKey,
        baseUrl: s.apiBaseUrl,
      },
      embedding: {
        model: s.embeddingModel,
        dimensions: resolveEmbeddingDimensions(s.embeddingModel, s.embeddingDimensions),
      },
      agent: {
        model: s.agentModel,
        thinking: {
          chat: s.agentThinkingChat,
          build: s.agentThinkingBuild,
          sort: s.agentThinkingSort,
        },
      },
      inboxFolder: s.inboxFolder,
      ignorePatterns: s.ignorePatterns,
      manifest: {
        filename: s.manifestFilename,
      },
      index: {
        warnMb: s.indexWarnMb,
      },
      query: {
        topK: s.queryTopK,
        depth: s.queryDepth,
        maxFanOut: s.queryMaxFanOut,
        maxSeeds: s.queryMaxSeeds,
        topReports: s.queryTopReports,
      },
      graph: {
        clusterThreshold: s.graphClusterThreshold,
        inferredThreshold: s.graphInferredThreshold,
        inferredMaxEdgesPerSection: s.graphInferredMaxEdgesPerSection,
      },
      reports: {
        contextCapTokens: s.reportsContextCapTokens,
      },
      extraction: {
        contextCapTokens: s.extractionContextCapTokens,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class VaultMaintenancePlugin extends Plugin {
  pluginSettings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  // YAML fallback layer (below the Settings tab): <pluginDir>/config.yaml —
  // the repo's machine-local config. data.json — the MAIN user config —
  // overrides it. No vault-level config file exists by design: vaults may be
  // shared (company databases) and must not carry API keys/parameters.
  private configBase: Partial<PluginSettings> = {};

  async onload(): Promise<void> {
    await this.loadConfigBase();
    await this.loadSettings();

    // Set up global settings from plugin config
    const vaultPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    updateSettings({
      vaultPath,
      configDir: this.app.vault.configDir,
      pluginDir: this.manifest.dir ?? "",
      dbPath: `${vaultPath}/${INDEX_DB_SUFFIX}`,
      api: {
        apiKey: this.pluginSettings.apiKey,
        baseUrl: this.pluginSettings.apiBaseUrl,
      },
      embedding: {
        model: this.pluginSettings.embeddingModel,
        dimensions: resolveEmbeddingDimensions(
          this.pluginSettings.embeddingModel,
          this.pluginSettings.embeddingDimensions,
        ),
      },
      agent: {
        model: this.pluginSettings.agentModel,
        thinking: {
          chat: this.pluginSettings.agentThinkingChat,
          build: this.pluginSettings.agentThinkingBuild,
          sort: this.pluginSettings.agentThinkingSort,
        },
      },
      inboxFolder: this.pluginSettings.inboxFolder,
      ignorePatterns: this.pluginSettings.ignorePatterns,
      manifest: {
        filename: this.pluginSettings.manifestFilename,
      },
      query: {
        topK: this.pluginSettings.queryTopK,
        depth: this.pluginSettings.queryDepth,
        maxFanOut: this.pluginSettings.queryMaxFanOut,
        maxSeeds: this.pluginSettings.queryMaxSeeds,
        topReports: this.pluginSettings.queryTopReports,
      },
      graph: {
        clusterThreshold: this.pluginSettings.graphClusterThreshold,
        inferredThreshold: this.pluginSettings.graphInferredThreshold,
        inferredMaxEdgesPerSection: this.pluginSettings.graphInferredMaxEdgesPerSection,
      },
      reports: {
        contextCapTokens: this.pluginSettings.reportsContextCapTokens,
      },
      extraction: {
        contextCapTokens: this.pluginSettings.extractionContextCapTokens,
      },
    });

    // Wire the sql.js DB host: vault-file I/O via the adapter (the vault API
    // — removes the better-sqlite3 direct-filesystem trigger), worker spawned
    // from the embedded bundle, wasm read from the plugin dir. The upgrade
    // hook fires once when a legacy index is retired to
    // .note-maintainer/legacy/. It must NOT rebuild: a rebuild fired from
    // inside the DB open path re-entered ensureChannel and recursed until
    // the renderer ran out of wasm memory (~108 nested sql.js workers). The
    // build that detected the legacy file already continues with a fresh
    // index (derived data — a deterministic one-time rebuild); for other
    // commands (clean/sort/chat) the fresh index fills on the next build.
    setDefaultDbHost(createObsidianDbHost(this.app.vault.adapter, vaultPath, {
      onIndexUpgraded: async () => {
        new Notice("Index engine upgraded — legacy index retired to .note-maintainer/legacy/ (one-time).");
      },
    }));

    // Register the sidebar review view so Obsidian can instantiate
    // vault-ease-of-maintenance review leaves.
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewView(leaf));

    this.addSettingTab(new VaultMaintenanceSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "build-index",
      name: "Build graphrag index",
      callback: () => this.handleBuild(),
    });

    this.addCommand({
      id: "clean-current-file",
      name: "Clean current note",
      callback: () => this.handleCleanCurrentFile(),
    });

    this.addCommand({
      id: "sort-inbox",
      name: "Sort inbox",
      callback: () => this.handleSort(),
    });

    this.addCommand({
      id: "chat-query",
      name: "Chat with your vault",
      callback: () => this.handleChat(),
    });

    // Ribbon entry point — same action as the command palette.
    this.addRibbonIcon("message-circle", "Chat with your vault", () => this.handleChat());

    // Fire-and-forget capability probe: notifies ONCE at startup when
    // detection succeeds (agentic vs fallback chat). Probe failures are
    // silent — a fresh install with no model configured must not nag.
    void this.runCapabilityStartupNotice();
  }

  onunload(): void {
    closeChatSession();
    resetRegistry();
  }

  // Probe the configured chat model's tool-call support and surface the
  // outcome once. "unknown" (probe failed / model unreachable) stays silent;
  // the probe is retried lazily from runChatQuery when the user chats.
  private async runCapabilityStartupNotice(): Promise<void> {
    const capability = await detectToolCallSupport();
    if (capability === "tool_calls") {
      new Notice("Vault ease of maintenance: tool calling detected — full agentic chat enabled.");
    } else if (capability === "no_tool_calls") {
      new Notice(
        "Vault ease of maintenance: this model can't call tools — chat uses retrieval fallback " +
        "mode (answers stay grounded in your notes).",
      );
    }
  }

  // Read one file best-effort; returns null when absent (first run, plugin
  // store install without config.yaml, etc.).
  private async tryReadConfigFile(path: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch {
      return null;
    }
  }

  async loadConfigBase(): Promise<void> {
    const pluginDir = this.manifest.dir ?? "";
    const pluginDirYaml = pluginDir
      ? await this.tryReadConfigFile(`${pluginDir}/${CONFIG_FILENAME}`)
      : null;
    this.configBase = pluginDirYaml ? parseConfigYaml(pluginDirYaml) : {};
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData() ?? {}) as Partial<PluginSettings>;
    // Priority: defaults ← <pluginDir>/config.yaml ← Settings tab (MAIN, wins).
    this.pluginSettings = mergeConfigLayers(DEFAULT_PLUGIN_SETTINGS, this.configBase, loaded);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.pluginSettings);
  }

  // ------------------------------------------------------------------
  // Review dispatch — one setting, two interchangeable containers
  // ------------------------------------------------------------------

  private openReview(spec: ReviewSpec): void {
    if (this.pluginSettings.reviewContainer === "sidebar") {
      void openReviewInSidebar(this.app, spec);
    } else {
      openReviewInModal(this.app, spec);
    }
  }

  // ------------------------------------------------------------------
  // Command handlers
  // ------------------------------------------------------------------

  async handleBuild(): Promise<void> {
    const notice = new Notice("Building index...", 0);
    try {
      const vaultPath = settings.vaultPath;
      if (!vaultPath) {
        notice.hide();
        new Notice("Vault path not available.");
        return;
      }
      const result = await runBuild(vaultPath);
      notice.hide();
      new Notice(result);
    } catch (e) {
      notice.hide();
      new Notice(`Build failed: ${errorMessage(e)}`);
    }
  }

  async handleCleanCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No file is currently open.");
      return;
    }

    const filePath = file.path;
    const notice = new Notice(`Cleaning ${filePath}...`, 0);

    try {
      const vaultPath = settings.vaultPath;
      const result = await runCleanup(filePath, vaultPath, true);

      notice.hide();

      if (typeof result === "string") {
        new Notice(result);
        return;
      }

      const proposal = result;
      if (!proposal.changed) {
        new Notice("No changes needed.");
        return;
      }

      const spec: ReviewSpec = {
        kind: "clean",
        id: `clean-${++reviewSeq}`,
        proposal: {
          filePath,
          vaultPath,
          original: proposal.original,
          cleaned: proposal.cleaned,
          validation: {
            passed: Object.values(proposal.validation).every(v => v[0]),
            checks: Object.fromEntries(
              Object.entries(proposal.validation).map(([k, v]) => [k, v[1]])
            ),
          },
          opsApplied: proposal.opsApplied,
          opsRejected: proposal.opsRejected,
        },
        onResolve: async (action) => {
          if (action === "reject") {
            return { ok: true, message: "Rejected — file not modified." };
          }
          try {
            acceptProposal(filePath, proposal);
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- function-scope require keeps the load-time chain minimal (Obsidian loader; see TROUBLESHOOTING-NOTES.md)
            const pathMod = require("path") as typeof import("path");
            return {
              ok: true,
              message: `Accepted — ${pathMod.basename(filePath)} written (backup at ${filePath}.bak).`,
            };
          } catch (e) {
            return { ok: false, message: `Write failed: ${errorMessage(e)}` };
          }
        },
      };
      this.openReview(spec);
    } catch (e) {
      notice.hide();
      new Notice(`Clean failed: ${errorMessage(e)}`);
    }
  }

  async handleSort(): Promise<void> {
    const notice = new Notice("Sorting inbox...", 0);
    try {
      const vaultPath = settings.vaultPath;
      const result = await runTriage(vaultPath, settings.inboxFolder);

      notice.hide();

      if (typeof result === "string") {
        new Notice(result);
        return;
      }

      const sortResult = result;
      const payload: SortResultPayload = {
        decisions: sortResult.decisions.map(d => ({
          unit_id: d.unitId,
          source_handle: d.sourceHandle,
          source_path: d.sourcePath,
          source_content: d.sourceContent,
          action: d.action,
          score: d.score,
          reason: d.reason,
          dest_path: d.destPath,
          dest_heading: d.destHeading,
          dest_context_before: d.destContextBefore,
          dest_context_after: d.destContextAfter,
        })),
        manifest_constitution: sortResult.manifestConstitution,
        suggestions: sortResult.suggestions,
        elapsed: sortResult.elapsed,
      };

      const spec: ReviewSpec = {
        kind: "sort",
        id: `sort-${++reviewSeq}`,
        result: payload,
      };
      this.openReview(spec);
    } catch (e) {
      notice.hide();
      new Notice(`Sort failed: ${errorMessage(e)}`);
    }
  }

  handleChat(): void {
    const spec: ReviewSpec = {
      kind: "chat",
      query: runChatQuery,
    };
    this.openReview(spec);
  }
}

// ---------------------------------------------------------------------------
// Accept — backup + write (called by the clean review's onResolve)
// ---------------------------------------------------------------------------

function acceptProposal(filePath: string, proposal: ProposedChange): void {
  const io = new VaultIO(settings.vaultPath);
  const rel = filePath.replace(/\\/g, "/").replace(/^\/+/, "");

  // Backup the current on-disk file
  const bakRel = rel + ".bak";
  let suffix = 0;
  while (io.exists(bakRel + (suffix ? `.${suffix}` : ""))) suffix++;
  io.copy(rel, bakRel + (suffix ? `.${suffix}` : ""));

  // Atomic write of the cleaned content (confined to the vault)
  io.writeTextAtomic(rel, proposal.cleaned);
}
