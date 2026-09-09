import type { DashboardActionTarget } from "./dashboard";
interface Operations {
    review?(id: string, status: 'approved' | 'dismissed' | 'deferred'): Promise<void>;
    importEvidence(): Promise<void>;
    compile(): Promise<void>;
    propose(): Promise<void>;
    evaluateLatest(): Promise<void>;
    cancel(): Promise<void>;
    retry(): Promise<void>;
}
interface ExportDependencies {
    saveData(): Promise<void>;
    writeVaultPackets(): Promise<void>;
    afterExport?(): Promise<void> | void;
}
/** Production action boundary used by WikiSkillView and injectable in host-shim tests. */
export class WikiSkillPluginActionTarget implements DashboardActionTarget {
    async review(id: string, status: 'approved' | 'dismissed' | 'deferred'): Promise<void> { await this.operations.review?.(id, status); }
    constructor(private readonly operations: Operations, private readonly exportDependencies: ExportDependencies) { }
    importEvidence(): Promise<void> {
        return this.operations.importEvidence();
    }
    compile(): Promise<void> {
        return this.operations.compile();
    }
    propose(): Promise<void> {
        return this.operations.propose();
    }
    evaluateLatest(): Promise<void> {
        return this.operations.evaluateLatest();
    }
    cancel(): Promise<void> {
        return this.operations.cancel();
    }
    retry(): Promise<void> {
        return this.operations.retry();
    }
    async exportReviewPackets(): Promise<void> {
        await this.exportDependencies.saveData();
        await this.exportDependencies.writeVaultPackets();
        await this.exportDependencies.afterExport?.();
    }
}
