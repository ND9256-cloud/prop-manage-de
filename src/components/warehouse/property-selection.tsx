'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    FileText,
    AlertTriangle,
    Building2,
    ClipboardList,
    Camera,
    AlertCircle,
    XCircle,
} from 'lucide-react';

type PropertyCard = {
    id: string;
    name: string;
    address: string;
    shortCode: string | null;
    totalDocs: number;
    needsReview: number;
    failed: number;
    photos: number;
    buckets: {
        kosten: number;
        versicherungen_vertraege: number;
        behoerden: number;
        sonstiges: number;
    };
};

type Stats = {
    total: number;
    needs_review: number;
    applied_this_month: number;
    properties_with_docs: number;
    photos: number;
    failed: number;
    unknown: number;
};

type Props = {
    stats: Stats;
    propertyCards: PropertyCard[];
    reviewCount: number;
    role: string;
};

export default function PropertySelection({ stats, propertyCards, reviewCount, role }: Props) {
    const router = useRouter();

    const isOperator = role === 'service_operator' || role === 'owner';


    return (
        <div className="space-y-6">
            {/* Page header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Dokumentenarchiv</h1>
                    <p className="text-sm text-muted-foreground">Dokumentenverwaltung</p>
                </div>
                {role !== 'viewer' && (
                    <Button
                        variant="outline"
                        onClick={() => router.push('/dashboard/warehouse/review')}
                        className="relative"
                    >
                        <ClipboardList className="mr-2 h-4 w-4" />
                        Review Queue
                        {reviewCount > 0 && (
                            <Badge className="ml-2 bg-amber-500 text-white hover:bg-amber-600">
                                {reviewCount}
                            </Badge>
                        )}
                    </Button>
                )}
            </div>

            {/* Portfolio bar */}
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Building2 className="h-4 w-4" />
                <span className="font-medium text-foreground">{propertyCards.length}</span> Objekte
                <span className="mx-1">&middot;</span>
                <FileText className="h-4 w-4" />
                <span className="font-medium text-foreground">{stats.total}</span> Dokumente
                <span className="mx-1">&middot;</span>
                <Camera className="h-4 w-4" />
                <span className="font-medium text-foreground">{stats.photos}</span> Fotos
                {isOperator && stats.needs_review > 0 && (
                    <>
                        <span className="mx-1">&middot;</span>
                        <span className="font-medium text-amber-600">{stats.needs_review} zur Prüfung</span>
                    </>
                )}
                {isOperator && stats.failed > 0 && (
                    <>
                        <span className="mx-1">&middot;</span>
                        <span className="font-medium text-red-600">{stats.failed} fehlgeschlagen</span>
                    </>
                )}
            </div>

            {/* Property cards grid */}
            <div>
                <h2 className="text-lg font-semibold mb-3">Immobilien</h2>
                {propertyCards.length === 0 ? (
                    <Card>
                        <CardContent className="p-8 text-center text-muted-foreground">
                            <Building2 className="mx-auto h-10 w-10 mb-2 opacity-40" />
                            <p>Keine Immobilien vorhanden.</p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {propertyCards.map((p) => (
                            <Card
                                key={p.id}
                                className="cursor-pointer hover:shadow-md transition-shadow"
                                onClick={() => router.push(`/dashboard/warehouse/${p.id}`)}
                            >
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base font-semibold">
                                        {p.address}
                                    </CardTitle>
                                    {p.shortCode && (
                                        <Badge variant="secondary" className="w-fit mt-1 text-xs">
                                            {p.shortCode}
                                        </Badge>
                                    )}
                                </CardHeader>
                                <CardContent className="pt-0 space-y-2">
                                    {/* Category rows */}
                                    <div className="space-y-1 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Kosten</span>
                                            <span className="font-medium">{p.buckets.kosten}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Versicherungen & Verträge</span>
                                            <span className="font-medium">{p.buckets.versicherungen_vertraege}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Behörden</span>
                                            <span className="font-medium">{p.buckets.behoerden}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Sonstiges</span>
                                            <span className="font-medium">{p.buckets.sonstiges}</span>
                                        </div>
                                    </div>

                                    {/* Operator badges */}
                                    {role !== 'viewer' && (p.needsReview > 0 || p.failed > 0) && (
                                        <div className="flex gap-2 pt-1">
                                            {p.needsReview > 0 && (
                                                <Badge variant="outline" className="text-amber-600 border-amber-300">
                                                    {p.needsReview} zur Prüfung
                                                </Badge>
                                            )}
                                            {p.failed > 0 && (
                                                <Badge variant="outline" className="text-red-600 border-red-300">
                                                    {p.failed} fehlgeschlagen
                                                </Badge>
                                            )}
                                        </div>
                                    )}

                                    {/* Footer: total doc count */}
                                    <div className="pt-2 border-t text-xs text-muted-foreground flex items-center gap-1.5">
                                        <FileText className="h-3.5 w-3.5" />
                                        {p.totalDocs} Dokumente
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>

            {/* Photo bar */}
            {stats.photos > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
                    <Camera className="h-4 w-4" />
                    <span>{stats.photos} Fotos im Archiv</span>
                </div>
            )}

            {/* Attention section (operator only) */}
            {isOperator && (stats.unknown > 0 || stats.failed > 0 || stats.needs_review > 0) && (
                <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
                    <CardContent className="p-4 space-y-2">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-amber-600" />
                            Handlungsbedarf
                        </h3>
                        <div className="flex flex-wrap gap-3 text-sm">
                            {stats.unknown > 0 && (
                                <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    {stats.unknown} nicht klassifiziert
                                </span>
                            )}
                            {stats.failed > 0 && (
                                <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                                    <XCircle className="h-3.5 w-3.5" />
                                    {stats.failed} fehlgeschlagen
                                </span>
                            )}
                            {stats.needs_review > 0 && (
                                <Button
                                    variant="link"
                                    className="h-auto p-0 text-sm text-amber-700 dark:text-amber-400"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        router.push('/dashboard/warehouse/inbox');
                                    }}
                                >
                                    {stats.needs_review} zur Prüfung
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

        </div>
    );
}
