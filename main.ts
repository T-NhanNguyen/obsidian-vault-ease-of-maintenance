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
import { runClearAction } from "./src/settings/clear_actions";
import { settingsTabPayload } from "./src/settings/persist";
import { pluginSettingsToNested } from "./src/settings/nested";
import {
  DEFAULT_PLUGIN_SETTINGS,
  PERSISTED_SETTING_KEYS,
  SETTING_META,
  TOKEN_CAP_MAX,
  TOKEN_CAP_MIN,
  TOKEN_CAP_STEP,
  normalizeSettingValue,
  parseTokenCap,
  type PluginSettings,
  type SettingButtonMeta,
  type SettingMeta,
  type SettingValueMeta,
} from "./src/settings/schema";
import { detectToolCallSupport, probeConnection } from "./src/agent/capability";
import { closeChatSession, closeClarifySession } from "./src/agent/chat_session";
import {
  runCleanup,
  runTriage,
  prepareBuild,
  runBuildIndex,
  DEFAULT_COMPREHENSION_QUESTION,
  ProposedChange,
} from "./src/agent/runtime";
import { runChatRouter, chatBusyMessage } from "./src/chat_router";
import { withChatLock } from "./src/chat_gate";
import { VaultIO } from "./src/io/vault_io";
import { setDefaultDbHost, createObsidianDbHost } from "./src/indexer/db_host";
import { resetRegistry } from "./src/agent/tools";
import { openReviewInModal } from "./src/container-modal";
import {
  openReviewInSidebar,
  REVIEW_VIEW_TYPE,
  ReviewView,
} from "./src/container-sidebar";
import type { ReviewSpec, SortResultPayload, ChatReviewSpec, ChatIntent, BuildProgressCallback } from "./src/types";

// ---------------------------------------------------------------------------
// Setting tab
// ---------------------------------------------------------------------------

// Unique ids for clean/sort review specs (ReviewCore dedupes by spec key).
let reviewSeq = 0;

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
      this.renderButtonSetting(setting, meta);
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

    if (meta.kind === "number") {
      this.renderNumberSetting(setting, meta);
      return;
    }

    setting.addText((text) => {
      text
        .setPlaceholder(meta.placeholder ?? "")
        .setValue(String(currentValue))
        .onChange((newValue) => this.setControlValue(meta.key, newValue));
    });
  }

  // One bounded number input, shared by BOTH settings paths.
  private renderNumberSetting(setting: Setting, meta: SettingValueMeta): void {
    setting.addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = String(TOKEN_CAP_MIN);
      text.inputEl.max = String(TOKEN_CAP_MAX);
      text.inputEl.step = String(TOKEN_CAP_STEP);
      text
        .setPlaceholder(meta.placeholder ?? "")
        .setValue(String(this.plugin.pluginSettings[meta.key]))
        .onChange((newValue) => {
          const parsed = parseTokenCap(newValue);
          if (parsed !== null) this.setControlValue(meta.key, parsed);
        });
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
      // SettingDefinitionRender — a REAL right-aligned push button. The
      // SettingDefinitionAction shape renders as a link-style clickable row
      // (reads as a hyperlink, not a button), so the declarative path mounts
      // the same Obsidian Setting + addButton the imperative path uses — one
      // shared renderer, identical look in both settings surfaces.
      return {
        ...base,
        render: (setting) => {
          // Name + desc set explicitly (idempotent) — guarantees the standard
          // white setting header + description regardless of what the
          // framework pre-applied.
          setting.setName(meta.name).setDesc(meta.desc);
          this.renderButtonSetting(setting, meta);
        },
      };
    }
    if (meta.kind === "number") {
      // SettingDefinitionRender, not a text control: the declarative path
      // mounts the same bounded number input the imperative path does.
      return {
        ...base,
        render: (setting) => {
          setting.setName(meta.name).setDesc(meta.desc);
          this.renderNumberSetting(setting, meta);
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

  // Shared button-row renderer for BOTH settings paths: name + desc come
  // from the Setting row (standard white header + description); this appends
  // the right-aligned push button and wires it to testConnection, which
  // disables it (greyed out) while the probe is in flight — blocking spam
  // clicks until the response returns.
  private renderButtonSetting(setting: Setting, meta: SettingButtonMeta): void {
    setting.addButton((button) => {
      button.setButtonText(meta.buttonText);
      button.onClick(() => {
        switch (meta.action) {
          case "test":
            void this.testConnection(button.buttonEl, meta.buttonText);
            return;
          case "clearIndex":
            void runClearAction(this.app, "index", button.buttonEl, meta.buttonText);
            return;
          case "clearComprehension":
            void runClearAction(this.app, "comprehension", button.buttonEl, meta.buttonText);
            return;
        }
      });
    });
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
    updateSettings(pluginSettingsToNested(this.plugin.pluginSettings));
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
      ...pluginSettingsToNested(this.pluginSettings),
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

    // The clarify dialog runs in the chat tab — the single entry point (the
    // chat agent loop exposes the clarify tool; the deterministic no-tool-call
    // path runs the same dialog on the same surface). No standalone command.
    this.addCommand({
      id: "chat-query",
      name: "Chat with your vault",
      callback: () => this.handleChat(),
    });

    // Vault comprehension — reads the vault like a book (skim → hypotheses →
    // verify → clarify → one-page summary card), hosted on the same chat
    // surface so mandatory clarifications flow through the in-flight answer
    // mode.
    this.addCommand({
      id: "understand-vault",
      name: "Understand vault (read it like a book)",
      callback: () => this.handleComprehension(),
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
    closeClarifySession();
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
    await this.saveData(settingsTabPayload(this.pluginSettings, PERSISTED_SETTING_KEYS));
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
      const { plan } = await prepareBuild(vaultPath);
      if (plan === "warm") {
        // The warm build is a headless run that shares the chat lock: while
        // any chat-surface run is in flight it is rejected with the same
        // busy message (protects the local LLM from concurrent load).
        // Live progress rewrites ONE persistent Notice in place — without it
        // this path is a black box from phase 1 to phase 2. The run result
        // (a string) doubles as the busy sentinel: null means it was rejected.
        notice.hide();
        const progressNotice = new Notice("Building index...", 0);
        const onProgress: BuildProgressCallback = (message) => progressNotice.setMessage(message);
        const result = await withChatLock(
          "build",
          () => runBuildIndex(vaultPath, onProgress),
          () => null,
        );
        progressNotice.hide();
        if (result === null) {
          new Notice(chatBusyMessage());
          return;
        }
        new Notice(
          `${result} — comprehension reused from the summary card; the manifest keeps its (needs review) markers.`,
        );
        return;
      }
      notice.hide();
      new Notice("Understanding the vault first — the index build will follow in the chat pane.");
      this.openReview({
        kind: "chat",
        intent: "build",
        query: this.chatQuery("build"),
        initialQuestion: DEFAULT_COMPREHENSION_QUESTION,
      });
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
      intent: "chat",
      query: this.chatQuery("chat"),
    };
    this.openReview(spec);
  }

  handleComprehension(): void {
    const spec: ReviewSpec = {
      kind: "chat",
      intent: "chat",
      query: this.chatQuery("chat"),
      initialQuestion: DEFAULT_COMPREHENSION_QUESTION,
    };
    this.openReview(spec);
  }

  // The chat pane's query — every intent routes through the shared router
  // (chat_router.ts), which owns the chat lock and the routing rules. The
  // build intent's closure carries a one-shot build-stage flag: the FIRST
  // question runs the stage (comprehension → manifest population → index
  // build) and every follow-up goes to regular RAG chat, so the chat is
  // never hogged by the build (defect 1: no more follow-up hijack).
  private chatQuery(intent: ChatIntent): ChatReviewSpec["query"] {
    let buildStagePending = intent === "build";
    return async (question, ask, onProgress) => {
      const runStage = buildStagePending;
      buildStagePending = false;
      return runChatRouter(question, ask, runStage, onProgress);
    };
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
