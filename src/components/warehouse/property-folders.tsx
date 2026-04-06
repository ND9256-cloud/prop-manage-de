'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    AlertTriangle,
    CheckCircle2,
    Clock,
    ChevronRight,
} from 'lucide-react';

type Folder = {
    key: string;
    de: string;
    en: string;
    icon: string;
    count: number;
    needsReview: number;
    totalSize: number;
    mostRecent: string | null;
};

type PropertyInfo = {
    id: string;
    name: string;
    address: string;
    shortCode: string | null;
};

type Stats = {
    total: number;
    needsReview: number;
    appliedThisMonth: number;
    oldestUnreviewed: string | null;
};

type Props = {
    property: PropertyInfo;
    folders: Folder[];
    stats: Stats;
    unassignedCount: number;
    readOnly?: boolean;
    unitCount?: number;
};

function formatDateDE(iso: string | null): string {
    if (!iso) return 'Keine Dokumente';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export default function PropertyFolders({ property, folders, stats, unassignedCount, readOnly, unitCount }: Props) {
    const router = useRouter();

    return (
        <div className="space-y-6">

            {/* Property stats row — only shown when there are items to review */}
            {stats.needsReview > 0 && !readOnly && (
                <div className="grid gap-4 grid-cols-2 md:grid-cols-3">
                    <Card>
                        <CardContent className="p-4 flex items-center gap-3">
                            <AlertTriangle className="h-5 w-5 text-amber-500" />
                            <div>
                                <p className="text-2xl font-bold">{stats.needsReview}</p>
                                <p className="text-xs text-muted-foreground">Prüfung nötig</p>
                            </div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-4 flex items-center gap-3">
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                            <div>
                                <p className="text-2xl font-bold">{stats.appliedThisMonth}</p>
                                <p className="text-xs text-muted-foreground">Angewendet (Monat)</p>
                            </div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-4 flex items-center gap-3">
                            <Clock className="h-5 w-5 text-orange-500" />
                            <div>
                                <p className="text-sm font-bold">
                                    {stats.oldestUnreviewed ? formatDateDE(stats.oldestUnreviewed) : '—'}
                                </p>
                                <p className="text-xs text-muted-foreground">Älteste offene Prüfung</p>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Document category list */}
            <div className="border rounded-lg divide-y">
                {folders.filter((f) => f.count > 0 && f.key !== 'medien').map((folder) => (
                    <div
                        key={folder.key}
                        className="flex items-center h-10 px-3 cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => router.push(`/dashboard/warehouse/${property.id}/${folder.key}`)}
                    >
                        <span className="text-base mr-2">{folder.icon}</span>
                        <span className="text-sm font-medium flex-1 truncate">{folder.de}</span>
                        {!readOnly && folder.needsReview > 0 && (
                            <Badge className="bg-amber-500 text-white hover:bg-amber-600 text-xs mr-2">
                                {folder.needsReview}
                            </Badge>
                        )}
                        <span className="text-sm text-muted-foreground tabular-nums mr-2">{folder.count}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                ))}
            </div>

            {/* Fotos & Medien section */}
            {folders.filter((f) => f.key === 'medien' && f.count > 0).map((folder) => (
                <div key={folder.key} className="space-y-2">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Fotos & Medien</h3>
                    <div className="border border-dashed rounded-lg divide-y">
                        <div
                            className="flex items-center h-10 px-3 cursor-pointer hover:bg-muted/50 transition-colors"
                            onClick={() => router.push(`/dashboard/warehouse/${property.id}/${folder.key}`)}
                        >
                            <span className="text-base mr-2">{folder.icon}</span>
                            <span className="text-sm font-medium flex-1 truncate">{folder.de}</span>
                            {!readOnly && folder.needsReview > 0 && (
                                <Badge className="bg-amber-500 text-white hover:bg-amber-600 text-xs mr-2">
                                    {folder.needsReview}
                                </Badge>
                            )}
                            <span className="text-sm text-muted-foreground tabular-nums mr-2">{folder.count}</span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                    </div>
                </div>
            ))}

            {/* Unassigned documents warning */}
            {unassignedCount > 0 && (
                <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/30">
                    <CardContent className="p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <AlertTriangle className="h-5 w-5 text-amber-600" />
                            <div>
                                <p className="font-medium text-amber-800 dark:text-amber-200">
                                    ⚠️ Nicht kategorisiert
                                </p>
                                <p className="text-sm text-amber-700 dark:text-amber-300">
                                    {unassignedCount} Dokument{unassignedCount !== 1 ? 'e' : ''} ohne Kategorie
                                </p>
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => router.push('/dashboard/warehouse/review')}
                            className="border-amber-400 text-amber-800 hover:bg-amber-100"
                        >
                            Jetzt zuweisen
                        </Button>
                    </CardContent>
                </Card>
            )}

        </div>
    );
}
