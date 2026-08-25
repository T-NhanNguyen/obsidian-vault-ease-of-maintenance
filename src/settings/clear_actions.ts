// Settings-tab clear actions (troubleshooting) — the confirm modal and the
// deletion flow for "Clear vault index" and "Clear comprehension data".
// main.ts keeps only the metadata rows and the one-line dispatch; this
// module owns the Obsidian UI + adapter wiring.

import { App, ButtonComponent, Modal, Notice } from "obsidian";
import { clearVaultIndex, clearComprehensionData, type ClearDataIO } from "../io/clear_data";

/** Which derived-data set a clear button targets. */
export type ClearActionKind = "index" | "comprehension";

/** Destructive-action confirmation for the settings clear buttons. Shows a
 * title and short description with Cancel/Clear buttons; only the explicit
 * Clear button runs the action. */
class ClearConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.modalEl.addClass("nm-clear-confirm-modal");
    this.contentEl.createDiv({ cls: "nm-clear-confirm-body", text: this.body });
    const buttonsEl = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttonsEl)
      .setButtonText("Cancel")
      .onClick(() => this.close());
    new ButtonComponent(buttonsEl)
      .setButtonText("Clear")
      .setCta()
      .onClick(() => {
        this.close();
        this.onConfirm();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Confirm-then-delete flow for one clear button: open the modal, and only
 * on explicit Clear run the adapter-backed deletion. The button stays
 * disabled while the files are removed and is restored in finally. */
export async function runClearAction(
  app: App,
  kind: ClearActionKind,
  buttonEl: HTMLButtonElement | null,
  restoreText: string,
): Promise<void> {
  const title = kind === "index" ? "Clear vault index?" : "Clear comprehension data?";
  const body =
    kind === "index"
      ? "Deletes the GraphRAG index (index.db, its sql.js sidecars) and the embedding cache. The next build recreates them from scratch."
      : "Deletes the comprehension ledger, state, skim cache, and summary card. The next build re-understands the vault from scratch.";
  new ClearConfirmModal(app, title, body, () => {
    void runClear(app, kind, buttonEl, restoreText);
  }).open();
}

async function runClear(
  app: App,
  kind: ClearActionKind,
  buttonEl: HTMLButtonElement | null,
  restoreText: string,
): Promise<void> {
  if (buttonEl) {
    buttonEl.disabled = true;
  }
  try {
    const io: ClearDataIO = app.vault.adapter;
    const result =
      kind === "index" ? await clearVaultIndex(io) : await clearComprehensionData(io);
    if (result.failed.length > 0) {
      console.warn(`[settings] ${kind} clear failed for: ${result.failed.join(", ")}`);
    }
    const removedLabel =
      result.removed.length === 0
        ? "Nothing to clear"
        : `Cleared ${result.removed.length} file${result.removed.length === 1 ? "" : "s"}`;
    const failureSuffix = result.failed.length > 0 ? `; ${result.failed.length} failed` : "";
    new Notice(`${removedLabel} — the next build recreates the derived data.${failureSuffix}`);
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = restoreText;
    }
  }
}
