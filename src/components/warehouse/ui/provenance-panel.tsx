import { ConfidenceBar } from './confidence-bar';
import { bilingual, t } from '@/lib/i18n/warehouse';

interface ProvenancePanelProps {
    documentName: string;
    extractedBy: string;
    extractedAt: string;
    appliedBy: string | null;
    appliedAt: string | null;
    confidence: number;
}

export function ProvenancePanel({
    documentName,
    extractedBy,
    extractedAt,
    appliedBy,
    appliedAt,
    confidence,
}: ProvenancePanelProps) {
    return (
        <div className="rounded-lg border border-border bg-muted p-4 space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {bilingual('provenance')}
            </h4>

            <div className="space-y-2 text-sm">
                <div className="flex items-start gap-2">
                    <span>📄</span>
                    <span className="text-foreground font-medium">{documentName}</span>
                </div>

                <div className="flex items-start gap-2">
                    <span>🤖</span>
                    <span className="text-muted-foreground">
                        {t.extractedBy.de} <span className="text-foreground">{extractedBy}</span>
                        {' '}{t.date.de.toLowerCase()} {extractedAt}
                    </span>
                </div>

                {appliedBy && appliedAt && (
                    <div className="flex items-start gap-2">
                        <span>✓</span>
                        <span className="text-muted-foreground">
                            {t.appliedBy.de} <span className="text-foreground">{appliedBy}</span>
                            {' '}{t.date.de.toLowerCase()} {appliedAt}
                        </span>
                    </div>
                )}
            </div>

            <div className="pt-1">
                <ConfidenceBar score={confidence} />
            </div>
        </div>
    );
}
