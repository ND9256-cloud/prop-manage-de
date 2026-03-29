'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { CATEGORIES, getCategoryHintLabel } from '@/lib/warehouse-categories';
import {
    ArrowLeft,
    Check,
    X,
    AlertTriangle,
    Search,
    Building2,
    Home,
    RefreshCw,
} from 'lucide-react';

interface ReviewTask {
    id: string;
    document_id: string;
    org_id: string;
    reason: string;
    reason_code: string;
    status: string;
    created_at: string;
    document: {
        file_name: string;
        display_name: string | null;
        doc_type: string | null;
        source: string;
        mime_type: string;
        property_id: string | null;
        category: string | null;
    } | null;
    extraction: {
        id: string;
        extracted_fields: Record<string, unknown>;
        confidence_score: number;
        flags: string[];
    } | null;
}

interface PropertyOption {
    id: string;
    name: string;
    address: string;
    shortCode: string | null;
    units: { id: string; unitNumber: string }[];
}

interface Props {
    initialTasks: ReviewTask[];
    properties: PropertyOption[];
}

function sourceIcon(source: string) {
    switch (source) {
        case 'email': return '📧';
        case 'telegram': return '✈️';
        case 'ui': return '🖥️';
        default: return '📄';
    }
}

function reasonLabel(code: string) {
    switch (code) {
        case 'low_confidence': return 'Low confidence — please verify';
        case 'new_asset_detected': return 'New asset — please confirm';
        case 'ambiguous_match': return 'Multiple matches found';
        case 'missing_required_field': return 'Missing required fields';
        default: return code;
    }
}

function reasonIcon(code: string) {
    switch (code) {
        case 'low_confidence': return <AlertTriangle className="h-4 w-4 text-amber-500" />;
        case 'new_asset_detected': return <Building2 className="h-4 w-4 text-blue-500" />;
        case 'ambiguous_match': return <Search className="h-4 w-4 text-purple-500" />;
        default: return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    }
}

function InvoiceFields({ fields }: { fields: Record<string, unknown> }) {
    return (
        <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
                <span className="text-muted-foreground">Vendor</span>
                <p className="font-medium">{String(fields.vendor_name || '—')}</p>
            </div>
            <div>
                <span className="text-muted-foreground">Amount</span>
                <p className="font-medium">
                    {fields.amount
                        ? Number(fields.amount).toLocaleString('de-DE', { style: 'currency', currency: String(fields.currency || 'EUR') })
                        : '—'}
                </p>
            </div>
            <div>
                <span className="text-muted-foreground">Date</span>
                <p className="font-medium" suppressHydrationWarning>
                    {fields.invoice_date
                        ? new Date(String(fields.invoice_date)).toLocaleDateString('de-DE')
                        : '—'}
                </p>
            </div>
            <div>
                <span className="text-muted-foreground">Category</span>
                <p className="font-medium">{getCategoryHintLabel(fields.category_hint as string)}</p>
            </div>
        </div>
    );
}

function LeaseFields({ fields }: { fields: Record<string, unknown> }) {
    return (
        <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
                <span className="text-muted-foreground">Tenant</span>
                <p className="font-medium">
                    {fields.tenant_first_name || fields.tenant_last_name
                        ? `${fields.tenant_first_name || ''} ${fields.tenant_last_name || ''}`.trim()
                        : '—'}
                </p>
            </div>
            <div>
                <span className="text-muted-foreground">Address</span>
                <p className="font-medium">{String(fields.address_street || '—')}</p>
            </div>
            <div>
                <span className="text-muted-foreground">Unit</span>
                <p className="font-medium">{String(fields.unit_ref || '—')}</p>
            </div>
            <div>
                <span className="text-muted-foreground">Rent</span>
                <p className="font-medium">
                    {fields.cold_rent
                        ? Number(fields.cold_rent).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
                        : '—'}
                </p>
            </div>
        </div>
    );
}

function OtherFields({ fields }: { fields: Record<string, unknown> }) {
    return (
        <div className="text-sm">
            <span className="text-muted-foreground">Summary</span>
            <p className="font-medium">{String(fields.description || fields.summary || '—')}</p>
        </div>
    );
}

function ConfidenceBar({ score }: { score: number }) {
    const percentage = Math.round(score * 100);
    const color = percentage >= 85 ? 'bg-green-500' : percentage >= 65 ? 'bg-amber-500' : 'bg-red-500';
    return (
        <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percentage}%` }} />
            </div>
            <span className="text-xs font-medium text-muted-foreground w-10 text-right">{percentage}%</span>
        </div>
    );
}

function ReviewTaskCard({
    task,
    properties,
    onApply,
    onDismiss,
}: {
    task: ReviewTask;
    properties: PropertyOption[];
    onApply: (taskId: string, propertyId?: string, unitId?: string, category?: string, displayName?: string) => void;
    onDismiss: (taskId: string) => void;
}) {
    const [selectedPropertyId, setSelectedPropertyId] = useState<string>('');
    const [selectedUnitId, setSelectedUnitId] = useState<string>('');
    const [selectedCategory, setSelectedCategory] = useState<string>(task.document?.category || '');
    const [editDisplayName, setEditDisplayName] = useState<string>(task.document?.file_name || '');
    const [isApplying, setIsApplying] = useState(false);
    const [isDismissing, setIsDismissing] = useState(false);

    const selectedProperty = properties.find(p => p.id === selectedPropertyId);
    const fields = task.extraction?.extracted_fields || {};
    const docType = task.document?.doc_type || 'other';

    return (
        <Card className="transition-all">
            <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">{sourceIcon(task.document?.source || '')}</span>
                        <div>
                            <CardTitle className="text-base">
                                {task.document?.file_name || 'Unknown file'}
                            </CardTitle>
                            <div className="flex items-center gap-2 mt-1">
                                <Badge variant="secondary">{docType}</Badge>
                                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                                    {reasonIcon(task.reason_code)}
                                    <span>{reasonLabel(task.reason_code)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Extracted Fields */}
                <div className="bg-gray-50 rounded-lg p-4">
                    {docType === 'invoice' && <InvoiceFields fields={fields} />}
                    {docType === 'lease' && <LeaseFields fields={fields} />}
                    {!['invoice', 'lease'].includes(docType) && <OtherFields fields={fields} />}
                </div>

                {/* Confidence */}
                {task.extraction && (
                    <div>
                        <p className="text-xs text-muted-foreground mb-1">Confidence</p>
                        <ConfidenceBar score={task.extraction.confidence_score * 100} />
                    </div>
                )}

                {/* Category + Display Name */}
                <div className="border-t pt-4 space-y-3">
                    <div className="flex gap-2">
                        <div className="flex-1">
                            <label className="text-xs text-muted-foreground mb-1 block">Kategorie / Category</label>
                            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Kategorie wählen..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {CATEGORIES.map(cat => (
                                        <SelectItem key={cat.key} value={cat.key}>
                                            {cat.de}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex-1">
                            <label className="text-xs text-muted-foreground mb-1 block">Dateiname / Filename</label>
                            <Input
                                value={editDisplayName}
                                onChange={e => setEditDisplayName(e.target.value)}
                                placeholder="YYYYMMDD_Vendor_KO132_Desc"
                            />
                        </div>
                    </div>
                </div>

                {/* Property Assignment */}
                <div className="border-t pt-4 space-y-3">
                    <div className="flex gap-2">
                        <div className="flex-1">
                            <label className="text-xs text-muted-foreground mb-1 block">Assign to Property</label>
                            <Select value={selectedPropertyId} onValueChange={(v) => { setSelectedPropertyId(v); setSelectedUnitId(''); }}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select property..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {properties.map(p => (
                                        <SelectItem key={p.id} value={p.id}>
                                            <div className="flex items-center gap-2">
                                                <Building2 className="h-3 w-3" />
                                                {p.name}
                                            </div>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {selectedProperty && selectedProperty.units.length > 0 && (
                            <div className="flex-1">
                                <label className="text-xs text-muted-foreground mb-1 block">Unit (optional)</label>
                                <Select value={selectedUnitId} onValueChange={setSelectedUnitId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select unit..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {selectedProperty.units.map(u => (
                                            <SelectItem key={u.id} value={u.id}>
                                                <div className="flex items-center gap-2">
                                                    <Home className="h-3 w-3" />
                                                    {u.unitNumber}
                                                </div>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                        <Button
                            className="flex-1"
                            onClick={async () => {
                                setIsApplying(true);
                                await onApply(
                                    task.id,
                                    selectedPropertyId || undefined,
                                    selectedUnitId || undefined,
                                    selectedCategory || undefined,
                                    editDisplayName || undefined,
                                );
                                setIsApplying(false);
                            }}
                            disabled={isApplying || isDismissing}
                        >
                            <Check className="h-4 w-4 mr-2" />
                            {isApplying ? 'Applying...' : 'Confirm & Apply'}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={async () => {
                                setIsDismissing(true);
                                await onDismiss(task.id);
                                setIsDismissing(false);
                            }}
                            disabled={isApplying || isDismissing}
                        >
                            <X className="h-4 w-4 mr-2" />
                            Dismiss
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

export default function ReviewQueue({ initialTasks, properties }: Props) {
    const [tasks, setTasks] = useState(initialTasks);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    useEffect(() => {
        if (toastMessage) {
            const timer = setTimeout(() => setToastMessage(null), 4000);
            return () => clearTimeout(timer);
        }
    }, [toastMessage]);

    const refresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const { getReviewTasks } = await import('@/lib/warehouse-actions');
            const result = await getReviewTasks();
            if (result.tasks) setTasks(result.tasks as ReviewTask[]);
        } finally {
            setIsRefreshing(false);
        }
    }, []);

    const handleApply = useCallback(async (taskId: string, propertyId?: string, unitId?: string, category?: string, displayName?: string) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task || !task.extraction) {
            setToastMessage('❌ Fehlende Daten / Missing extraction data');
            return;
        }

        try {
            // Step 1: Save metadata first
            if (category || displayName) {
                const { updateDocumentMetadata } = await import('@/lib/warehouse-actions');
                const metaResult = await updateDocumentMetadata(
                    task.document_id,
                    displayName || '',
                    category || '',
                );
                if (metaResult.error) {
                    setToastMessage(`❌ Fehler beim Ablegen / Filing failed: ${metaResult.error}`);
                    console.error('updateDocumentMetadata failed:', metaResult.error);
                    return;
                }
            }

            // Step 2: Apply via connector
            const { applyReviewTask } = await import('@/lib/warehouse-actions');
            const result = await applyReviewTask(
                task.document_id,
                task.extraction.id,
                task.document?.doc_type || 'other',
                task.extraction.extracted_fields,
                propertyId,
                unitId,
            );

            if (result.error) {
                setToastMessage(`❌ Fehler beim Ablegen / Filing failed: ${result.error}`);
                console.error('applyReviewTask failed:', result.error);
            } else {
                setToastMessage('✅ Dokument abgelegt / Document filed');
                setTasks(prev => prev.filter(t => t.id !== taskId));
            }
        } catch (e) {
            setToastMessage('❌ Fehler beim Ablegen / Filing failed');
            console.error('Apply error:', e);
        }
    }, [tasks]);

    const handleDismiss = useCallback(async (taskId: string) => {
        try {
            const { dismissReviewTask } = await import('@/lib/warehouse-actions');
            const result = await dismissReviewTask(taskId);

            if (result.error) {
                setToastMessage(`❌ ${result.error}`);
            } else {
                setToastMessage('Task dismissed');
                setTasks(prev => prev.filter(t => t.id !== taskId));
            }
        } catch {
            setToastMessage('❌ Dismiss failed. Please try again.');
        }
    }, []);

    return (
        <main className="p-6">
            {/* Toast */}
            {toastMessage && (
                <div className="fixed top-4 right-4 z-50 bg-white border rounded-lg shadow-lg px-4 py-3 text-sm max-w-md animate-in fade-in slide-in-from-top-2">
                    {toastMessage}
                </div>
            )}

            {/* Header */}
            <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Link href="/dashboard/warehouse">
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold">Review Queue</h1>
                        <p className="text-muted-foreground">
                            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} needing attention
                        </p>
                    </div>
                </div>
                <Button variant="outline" onClick={refresh} disabled={isRefreshing}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            {/* Tasks */}
            {tasks.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <Check className="h-12 w-12 mx-auto mb-3 text-green-500" />
                        <p className="text-lg font-medium">All caught up!</p>
                        <p className="text-muted-foreground">No documents need review right now.</p>
                        <Link href="/dashboard/warehouse">
                            <Button variant="outline" className="mt-4">
                                Back to Warehouse
                            </Button>
                        </Link>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-6">
                    {(() => {
                        // Group tasks by property_id
                        const groups: Record<string, ReviewTask[]> = {};
                        const unassigned: ReviewTask[] = [];
                        for (const task of tasks) {
                            const pid = task.document?.property_id;
                            if (pid) {
                                if (!groups[pid]) groups[pid] = [];
                                groups[pid].push(task);
                            } else {
                                unassigned.push(task);
                            }
                        }
                        const propIds = Object.keys(groups);
                        return (
                            <>
                                {propIds.map(pid => {
                                    const prop = properties.find(p => p.id === pid);
                                    return (
                                        <div key={pid}>
                                            <div className="flex items-center gap-2 mb-3">
                                                <Building2 className="h-5 w-5 text-muted-foreground" />
                                                <h2 className="text-lg font-bold">{prop?.address || prop?.name || pid}</h2>
                                                {prop?.shortCode && (
                                                    <Badge variant="secondary">{prop.shortCode}</Badge>
                                                )}
                                                <Badge variant="outline" className="ml-auto">{groups[pid].length}</Badge>
                                            </div>
                                            <div className="space-y-4 ml-1">
                                                {groups[pid].map(task => (
                                                    <ReviewTaskCard
                                                        key={task.id}
                                                        task={task}
                                                        properties={properties}
                                                        onApply={handleApply}
                                                        onDismiss={handleDismiss}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                                {unassigned.length > 0 && (
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <AlertTriangle className="h-5 w-5 text-amber-500" />
                                            <h2 className="text-lg font-bold">⚠️ Nicht zugewiesen / Unassigned</h2>
                                            <Badge variant="outline" className="ml-auto">{unassigned.length}</Badge>
                                        </div>
                                        <div className="space-y-4 ml-1">
                                            {unassigned.map(task => (
                                                <ReviewTaskCard
                                                    key={task.id}
                                                    task={task}
                                                    properties={properties}
                                                    onApply={handleApply}
                                                    onDismiss={handleDismiss}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </>
                        );
                    })()}
                </div>
            )}
        </main>
    );
}
