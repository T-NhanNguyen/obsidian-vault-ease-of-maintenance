// Obsidian Vault Ease of Maintenance Plugin
// All-in-plugin GraphRAG indexer + LLM-driven agents.
// Path C: No server, no Python, no Docker — runs entirely inside Obsidian.
//
// Clean/sort/chat reviews render through the shared ReviewCore into one of
// two interchangeable containers — a docked right sidebar pane (default) or
// a centered modal overlay — chosen in the plugin settings.

import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { updateSettings, settings, INDEX_DB_SUFFIX } from "./src/config";
import { setHttpTransport } from "./src/http";
import {
  runCleanup,
  runTriage,
  runBuild,
  runChatQuery,
  SortResult,
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
// Setting Tab
// ---------------------------------------------------------------------------

class VaultMaintenanceSettingTab extends PluginSettingTab {
  plugin: VaultMaintenancePlugin;

  constructor(app: App, plugin: VaultMaintenancePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Vault Maintenance — Settings").setHeading();

    new Setting(containerEl)
      .setName("Review container")
      .setDesc("Where clean/sort reviews and chat open: a docked sidebar pane or a centered modal overlay.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sidebar", "Sidebar pane")
          .addOption("modal", "Modal overlay")
          .setValue(this.plugin.pluginSettings.reviewContainer)
          .onChange(async (value) => {
            this.plugin.pluginSettings.reviewContainer = value as ReviewContainer;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("API key for OpenAI / OpenRouter / local LLM. Leave empty to use env vars.")
      .addText(text => text
        .setPlaceholder("sk-...")
        .setValue(this.plugin.pluginSettings.apiKey)
        .onChange(async (value) => {
          this.plugin.pluginSettings.apiKey = value.trim();
          await this.plugin.saveSettings();
          this.applySettings();
        }));

    new Setting(containerEl)
      .setName("API Base URL")
      .setDesc("Base URL for the OpenAI-compatible API.")
      .addText(text => text
        .setPlaceholder("https://api.openai.com/v1")
        .setValue(this.plugin.pluginSettings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.pluginSettings.apiBaseUrl = value.trim();
          await this.plugin.saveSettings();
          this.applySettings();
        }));

    new Setting(containerEl)
      .setName("Agent Model")
      .setDesc("Model for cleanup, sort, and chat agents.")
      .addText(text => text
        .setPlaceholder("gpt-4o-mini")
        .setValue(this.plugin.pluginSettings.agentModel)
        .onChange(async (value) => {
          this.plugin.pluginSettings.agentModel = value.trim();
          await this.plugin.saveSettings();
          this.applySettings();
        }));

    new Setting(containerEl)
      .setName("Embedding Model")
      .setDesc("Model for text embeddings.")
      .addText(text => text
        .setPlaceholder("text-embedding-3-small")
        .setValue(this.plugin.pluginSettings.embeddingModel)
        .onChange(async (value) => {
          this.plugin.pluginSettings.embeddingModel = value.trim();
          await this.plugin.saveSettings();
          this.applySettings();
        }));

    new Setting(containerEl)
      .setName("Inbox Folder")
      .setDesc("Folder name for inbox triage (leave empty for auto-discover).")
      .addText(text => text
        .setPlaceholder("inbox")
        .setValue(this.plugin.pluginSettings.inboxFolder)
        .onChange(async (value) => {
          this.plugin.pluginSettings.inboxFolder = value.trim();
          await this.plugin.saveSettings();
          this.applySettings();
        }));

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc("One glob pattern per line. The plugin skips matching files and folders during indexing and sorting.")
      .addTextArea(text => {
        text.setPlaceholder("archive/\n*.bak");
        text.setValue(this.plugin.pluginSettings.ignorePatterns);
        text.inputEl.rows = 5;
        text.onChange(async (value) => {
          this.plugin.pluginSettings.ignorePatterns = value;
          await this.plugin.saveSettings();
          this.applySettings();
        });
      });

    new Setting(containerEl)
      .setName("Manifest Filename")
      .setDesc("Name of the vault manifest file (default: _manifest.md).")
      .addText(text => text
        .setPlaceholder("_manifest.md")
        .setValue(this.plugin.pluginSettings.manifestFilename)
        .onChange(async (value) => {
          this.plugin.pluginSettings.manifestFilename = value.trim() || "_manifest.md";
          await this.plugin.saveSettings();
          this.applySettings();
        }));
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

    // Obsidian's requestUrl is the network transport in the plugin (CORS-safe,
    // proxy-aware); plain-Node dev/tests keep global fetch (src/http.ts).
    setHttpTransport("requestUrl");

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
      name: "Build GraphRAG index",
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
    const loaded = await this.loadData();
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
    } catch (e: any) {
      notice.hide();
      new Notice(`Build failed: ${e.message}`);
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

      const proposal = result as ProposedChange;
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
            // eslint-disable-next-line @typescript-eslint/no-var-requires -- function-scope require keeps the load-time chain minimal (Obsidian loader; see TROUBLESHOOTING-NOTES.md)
            const { basename } = require("path");
            return {
              ok: true,
              message: `Accepted — ${basename(filePath)} written (backup at ${filePath}.bak).`,
            };
          } catch (e: any) {
            return { ok: false, message: `Write failed: ${e.message}` };
          }
        },
      };
      this.openReview(spec);
    } catch (e: any) {
      notice.hide();
      new Notice(`Clean failed: ${e.message}`);
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

      const sortResult = result as SortResult;
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
    } catch (e: any) {
      notice.hide();
      new Notice(`Sort failed: ${e.message}`);
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
  /* eslint-disable @typescript-eslint/no-var-requires -- function-scope require keeps the load-time chain minimal (Obsidian loader; see TROUBLESHOOTING-NOTES.md) */
  const fs = require("fs");
  const crypto = require("crypto");
  const path = require("path");
  /* eslint-enable @typescript-eslint/no-var-requires */

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
