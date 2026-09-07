import { normalizePath, TFile, type Vault } from "obsidian";
import type { PluginState } from "./state";
import {
  renderEvolution,
  renderImpact,
  renderIndex,
  renderPattern,
  renderReview,
} from "./wiki";

export class VaultWikiStore {
  constructor(private readonly vault: Vault) {}
  async write(state: PluginState): Promise<void> {
    const root = normalizePath(state.settings.outputRoot);
    if (!root || root.startsWith("/") || root.split("/").includes(".."))
      throw new Error(
        "Knowledge output folder must be a vault-relative contained path",
      );
    await this.put(`${root}/index.md`, renderIndex(state.patterns));
    for (const pattern of state.patterns)
      await this.put(
        `${root}/${segment(pattern.skill)}/patterns/${segment(pattern.id)}.md`,
        renderPattern(pattern),
      );
    for (const skill of new Set([
      ...state.patterns.map((p) => p.skill),
      ...state.candidates.map((c) => c.skill),
    ])) {
      await this.put(
        `${root}/${segment(skill)}/evolution-log.md`,
        renderEvolution(state.candidates.filter((c) => c.skill === skill)),
      );
      await this.put(
        `${root}/${segment(skill)}/impact-history.md`,
        renderImpact(
          state.evaluations.filter(
            (e) =>
              state.candidates.find((c) => c.id === e.candidateId)?.skill ===
              skill,
          ),
        ),
      );
    }
    for (const evaluation of state.evaluations) {
      const candidate = state.candidates.find(
        (item) => item.id === evaluation.candidateId,
      );
      if (candidate)
        await this.put(
          `${root}/${segment(candidate.skill)}/reviews/${segment(candidate.id)}.md`,
          renderReview(candidate, evaluation),
        );
    }
  }
  private async put(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    if (parent && !this.vault.getAbstractFileByPath(parent))
      await this.ensureFolder(parent);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) await this.vault.modify(file, content);
    else if (!file) await this.vault.create(normalized, content);
  }
  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const segment of path.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current))
        await this.vault.createFolder(current);
    }
  }
}
function segment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^\.+$/, "item")
      .slice(0, 100) || "item"
  );
}
