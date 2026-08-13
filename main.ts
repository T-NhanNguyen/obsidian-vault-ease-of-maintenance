// Obsidian Vault Ease of Maintenance Plugin
// All-in-plugin GraphRAG indexer + LLM-driven agents.
// Path C: No server, no Python, no Docker — runs entirely inside Obsidian.
//
// Clean/sort/chat reviews render through the shared ReviewCore into one of
// two interchangeable containers — a docked right sidebar pane (default) or
// a centered modal overlay — chosen in the plugin settings.

import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import { updateSettings, settings, INDEX_DB_SUFFIX } from "./src/config";
import { errorMessage } from "./src/errors";
import {
  runCleanup,
  runTriage,
  runBuild,
  runChatQuery,
  ProposedChange,
} from "./src/agent/runtime";
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
  inboxFolder: string;
  ignorePatterns: string;
  manifestFilename: string;
  reviewContainer: ReviewContainer;
}

const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1",
  agentModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  inboxFolder: "",
  ignorePatterns: "",
  manifestFilename: "_manifest.md",
  reviewContainer: "sidebar",
};

// Unique ids for clean/sort review specs (ReviewCore dedupes by spec key).
let reviewSeq = 0;

// ---------------------------------------------------------------------------
// Setting Tab — metadata-driven dual-path rendering
// ---------------------------------------------------------------------------
// One SETTING_META table drives both rendering paths so the two surfaces
// cannot drift: the declarative getSettingDefinitions() (Obsidian 1.13.0+
// settings search) and the imperative display() (Obsidian < 1.13.0).

interface SettingMeta {
  kind: "text" | "textarea" | "dropdown";
  key: keyof PluginSettings;
  name: string;
  desc: string;
  placeholder?: string;
  rows?: number;
  options?: Record<string, string>;
}

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
    desc: "API key for OpenAI / openrouter / local LLM. Leave empty to use env vars.",
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
    name: "Agent model",
    desc: "Model for cleanup, sort, and chat agents.",
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
    return {
      ...base,
      control: {
        type: "text",
        key: meta.key,
        placeholder: meta.placeholder,
      },
    };
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
        dimensions: s.embeddingModel.includes("large") ? 3072 : 1536,
      },
      agent: {
        model: s.agentModel,
      },
      inboxFolder: s.inboxFolder,
      ignorePatterns: s.ignorePatterns,
      manifest: {
        filename: s.manifestFilename,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class VaultMaintenancePlugin extends Plugin {
  pluginSettings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;

  async onload(): Promise<void> {
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
        dimensions: this.pluginSettings.embeddingModel.includes("large") ? 3072 : 1536,
      },
      agent: {
        model: this.pluginSettings.agentModel,
      },
      inboxFolder: this.pluginSettings.inboxFolder,
      ignorePatterns: this.pluginSettings.ignorePatterns,
      manifest: {
        filename: this.pluginSettings.manifestFilename,
      },
    });

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
  }

  onunload(): void {
    resetRegistry();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData() ?? {}) as Partial<PluginSettings>;
    this.pluginSettings = Object.assign({}, DEFAULT_PLUGIN_SETTINGS, loaded);
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
  /* eslint-disable @typescript-eslint/no-require-imports -- function-scope require keeps the load-time chain minimal (Obsidian loader; see TROUBLESHOOTING-NOTES.md) */
  const fs = require("fs") as typeof import("fs");
  const crypto = require("crypto") as typeof import("crypto");
  const path = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports -- function-scope require keeps the load-time chain minimal (Obsidian loader; see TROUBLESHOOTING-NOTES.md) */

  const absPath = path.join(settings.vaultPath, filePath);

  // Backup the current on-disk file
  const bakPath = absPath + ".bak";
  let suffix = 0;
  while (fs.existsSync(bakPath + (suffix ? `.${suffix}` : ""))) suffix++;
  fs.copyFileSync(absPath, bakPath + (suffix ? `.${suffix}` : ""));

  // Atomic write of the cleaned content
  const tmpPath = absPath + `.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpPath, proposal.cleaned, "utf-8");
  fs.renameSync(tmpPath, absPath);
}
