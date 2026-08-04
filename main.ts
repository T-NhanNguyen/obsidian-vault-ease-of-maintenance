// Obsidian Vault Ease of Maintenance Plugin
// All-in-plugin GraphRAG indexer + LLM-driven agents.
// Path C: No server, no Python, no Docker — runs entirely inside Obsidian.

import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownRenderer,
} from "obsidian";
import { updateSettings, settings, resolveApiKey, Settings, defaultSettings } from "./src/config";
import { Indexer } from "./src/indexer/indexer";
import {
  runCleanup,
  runTriage,
  runChat,
  runBuild,
  SortResult,
  ProposedChange,
} from "./src/agent/runtime";
import { resetRegistry } from "./src/agent/tools";

// ---------------------------------------------------------------------------
// Plugin Settings
// ---------------------------------------------------------------------------

interface PluginSettings {
  apiKey: string;
  apiBaseUrl: string;
  agentModel: string;
  embeddingModel: string;
  inboxFolder: string;
  ignorePatterns: string;
  manifestFilename: string;
}

const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1",
  agentModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  inboxFolder: "",
  ignorePatterns: "",
  manifestFilename: "_manifest.md",
};

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

    containerEl.createEl("h2", { text: "Vault Maintenance — Settings" });

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

    // Set up global settings from plugin config
    const vaultPath = (this.app.vault.adapter as any).basePath || "";
    updateSettings({
      vaultPath,
      dbPath: `${vaultPath}/.note-maintainer/index.db`,
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

      // Show diff modal for review
      new DiffReviewModal(this.app, proposal, async (accepted) => {
        if (accepted) {
          // Write the cleaned content
          const absPath = `${settings.vaultPath}/${filePath}`;
          const fs = require("fs");
          const crypto = require("crypto");
          const original = fs.readFileSync(absPath, "utf-8");

          // Backup
          const bakPath = absPath + ".bak";
          let suffix = 0;
          while (fs.existsSync(bakPath + (suffix ? `.${suffix}` : ""))) suffix++;
          fs.copyFileSync(absPath, bakPath + (suffix ? `.${suffix}` : ""));

          // Write cleaned
          const tmpPath = absPath + `.tmp-${crypto.randomBytes(4).toString("hex")}`;
          fs.writeFileSync(tmpPath, proposal.cleaned, "utf-8");
          fs.renameSync(tmpPath, absPath);

          new Notice(`Cleaned — backup saved.`);
        }
      }).open();
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
      new ReviewPanelModal(this.app, sortResult).open();
    } catch (e: any) {
      notice.hide();
      new Notice(`Sort failed: ${e.message}`);
    }
  }

  async handleChat(): Promise<void> {
    new ChatModal(this.app).open();
  }
}

// ---------------------------------------------------------------------------
// UI Components — Obsidian native modals
// ---------------------------------------------------------------------------

class DiffReviewModal extends Modal {
  private proposal: ProposedChange;
  private onResolve: (accepted: boolean) => void;

  constructor(app: App, proposal: ProposedChange, onResolve: (accepted: boolean) => void) {
    super(app);
    this.proposal = proposal;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: `Cleanup Review — ${this.proposal.filePath}` });

    // Validation status
    const allPassed = Object.values(this.proposal.validation).every(v => v[0]);
    const statusEl = contentEl.createEl("div", {
      cls: allPassed ? "clean-review-pass" : "clean-review-fail",
    });
    statusEl.setText(allPassed ? "✅ All validators passed" : "⚠️ Validation warnings");

    if (!allPassed) {
      const list = statusEl.createEl("ul");
      for (const [k, v] of Object.entries(this.proposal.validation)) {
        if (!v[0]) list.createEl("li", { text: `${k}: ${v[1]}` });
      }
    }

    // Side-by-side diff
    const diffContainer = contentEl.createEl("div", { cls: "diff-container" });
    diffContainer.style.display = "flex";
    diffContainer.style.gap = "12px";

    const origPanel = diffContainer.createEl("div", { cls: "diff-panel" });
    origPanel.createEl("h4", { text: "Original" });
    const origPre = origPanel.createEl("pre", { text: this.proposal.original });
    origPre.style.cssText = "max-height:60vh;overflow:auto;font-size:0.8rem;white-space:pre-wrap;background:#fff3f3;padding:8px;border-radius:4px;flex:1";

    const cleanPanel = diffContainer.createEl("div", { cls: "diff-panel" });
    cleanPanel.createEl("h4", { text: "Cleaned" });
    const cleanPre = cleanPanel.createEl("pre", { text: this.proposal.cleaned });
    cleanPre.style.cssText = "max-height:60vh;overflow:auto;font-size:0.8rem;white-space:pre-wrap;background:#f3fff3;padding:8px;border-radius:4px;flex:1";

    // Actions
    const actions = contentEl.createEl("div", { cls: "diff-actions" });
    actions.style.cssText = "display:flex;gap:12px;margin-top:16px";

    const acceptBtn = actions.createEl("button", { text: "Accept — write file", cls: "mod-cta" });
    acceptBtn.addEventListener("click", () => {
      this.close();
      this.onResolve(true);
    });

    const rejectBtn = actions.createEl("button", { text: "Reject — keep original" });
    rejectBtn.addEventListener("click", () => {
      this.close();
      this.onResolve(false);
    });
  }

  onClose(): void {
    (this as any).contentEl.empty();
  }
}

class ReviewPanelModal extends Modal {
  private result: SortResult;

  constructor(app: App, result: SortResult) {
    super(app);
    this.result = result;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Sort Review" });
    contentEl.createEl("p", {
      text: `${this.result.placed.length} placed, ${this.result.flagged.length} flagged in ${this.result.elapsed.toFixed(0)}s`,
    });

    for (const d of this.result.decisions) {
      const card = contentEl.createEl("div", { cls: "sort-card" });
      card.style.cssText = "background:#fff;border:1px solid #dee2e6;border-radius:6px;padding:10px;margin-bottom:8px";

      const badge = card.createEl("span", {
        text: d.action === "placed" ? "✓ PLACED" : d.action === "near_duplicate" ? "⚠️ NEAR-DUP" : "❓ FLAGGED",
      });
      badge.style.cssText = `font-weight:600;margin-right:8px;color:${d.action === "placed" ? "#28a745" : d.action === "near_duplicate" ? "#dc3545" : "#856404"}`;

      card.createEl("span", { text: `${d.sourcePath} → ${d.destPath || "(none)"}` });

      if (d.reason) card.createEl("p", { text: d.reason, cls: "sort-reason" });
    }

    if (this.result.suggestions) {
      const sug = contentEl.createEl("div", { cls: "sort-suggestions" });
      sug.style.cssText = "background:#f0f7ff;border:1px solid #b8d4f0;border-radius:6px;padding:12px;margin-top:16px";
      sug.createEl("h4", { text: "Suggestions" });
      sug.createEl("p", { text: this.result.suggestions });
    }
  }

  onClose(): void {
    (this as any).contentEl.empty();
  }
}

class ChatModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Chat with Your Vault" });

    const inputRow = contentEl.createEl("div");
    inputRow.style.cssText = "display:flex;gap:8px;margin-bottom:12px";

    const input = inputRow.createEl("input", { type: "text", placeholder: "Ask a question..." });
    input.style.cssText = "flex:1;padding:8px;border:1px solid #ccc;border-radius:4px";

    const resultsEl = contentEl.createEl("div");

    const search = async () => {
      const q = input.value.trim();
      if (!q) return;

      resultsEl.empty();
      resultsEl.createEl("p", { text: "Searching..." });

      try {
        const answer = await runChat(q);
        resultsEl.empty();

        const answerEl = resultsEl.createEl("div");
        answerEl.style.cssText = "background:#f0f7ff;border:1px solid #b8d4f0;border-radius:6px;padding:12px;margin-top:8px";
        answerEl.createEl("h4", { text: "Answer" });
        answerEl.createEl("div", { text: answer });
      } catch (e: any) {
        resultsEl.empty();
        resultsEl.createEl("p", { text: `Error: ${e.message}`, cls: "mod-warning" });
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") search();
    });

    const btn = inputRow.createEl("button", { text: "Search", cls: "mod-cta" });
    btn.addEventListener("click", search);
  }

  onClose(): void {
    (this as any).contentEl.empty();
  }
}
