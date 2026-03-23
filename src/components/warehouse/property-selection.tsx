'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { uploadWarehouseDocument } from '@/lib/warehouse-actions';
import {
    FileText,
    AlertTriangle,
    Building2,
    Upload,
    ClipboardList,
    X,
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
    statusDot: 'red' | 'green' | 'gray';
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
    const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [selectedPropertyId, setSelectedPropertyId] = useState('');
    const [uploading, setUploading] = useState(false);

    const isOperator = role === 'service_operator' || role === 'owner';

    const onDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(true);
    }, []);

    const onDragLeave = useCallback(() => setDragging(false), []);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) {
            setSelectedFile(file);
            setShowModal(true);
        }
    }, []);

    const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedFile(file);
            setShowModal(true);
        }
    }, []);

    const handleUpload = async () => {
        if (!selectedFile || !selectedPropertyId) return;
        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', selectedFile);
            formData.append('propertyId', selectedPropertyId);
            const result = await uploadWarehouseDocument(formData);
            if (result.error) {
                setNotification({ msg: result.error, type: 'error' });
            } else {
                setNotification({ msg: `${selectedFile.name} wird verarbeitet...`, type: 'success' });
                setTimeout(() => setNotification(null), 4000);
                setShowModal(false);
                setSelectedFile(null);
                setSelectedPropertyId('');
                router.refresh();
            }
        } finally {
            setUploading(false);
        }
    };

    const dotColor = (dot: string) => {
        if (dot === 'red') return 'bg-red-500';
        if (dot === 'green') return 'bg-green-500';
        return 'bg-gray-400';
    };

    return (
        <div className="space-y-6">
            {/* Notification banner */}
            {notification && (
                <div
                    className={`p-3 rounded-md text-sm font-medium ${notification.type === 'success'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                        }`}
                >
                    {notification.msg}
                </div>
            )}

            {/* Page header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Warehouse</h1>
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
                                className="cursor-pointer hover:shadow-md transition-shadow relative"
                                onClick={() => router.push(`/dashboard/warehouse/${p.id}`)}
                            >
                                {/* Status dot */}
                                <div
                                    className={`absolute top-4 right-4 h-3 w-3 rounded-full ${dotColor(
                                        p.statusDot
                                    )}`}
                                />
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base font-semibold pr-6">
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

            {/* Global upload zone (hidden for viewers) */}
            {role !== 'viewer' && (
                <div
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${dragging
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                        }`}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    onClick={() => document.getElementById('file-upload')?.click()}
                >
                    <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                    <p className="font-medium">Dokument hochladen / Upload document</p>
                    <p className="text-sm text-muted-foreground mt-1">
                        Datei hierher ziehen oder klicken
                    </p>
                    <input
                        id="file-upload"
                        type="file"
                        className="hidden"
                        onChange={onFileSelect}
                        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
                    />
                </div>
            )}

            {/* Upload modal */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <Card className="w-full max-w-md mx-4">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="text-lg">
                                Zu welcher Immobilie gehört dieses Dokument?
                            </CardTitle>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setShowModal(false);
                                    setSelectedFile(null);
                                }}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="p-3 bg-muted rounded-md text-sm">
                                <FileText className="inline h-4 w-4 mr-2" />
                                {selectedFile?.name}
                            </div>
                            <Select value={selectedPropertyId} onValueChange={setSelectedPropertyId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Immobilie auswählen..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {propertyCards.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                            {p.address}
                                            {p.shortCode ? ` (${p.shortCode})` : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <div className="flex gap-2 justify-end">
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        setShowModal(false);
                                        setSelectedFile(null);
                                    }}
                                >
                                    Abbrechen
                                </Button>
                                <Button
                                    onClick={handleUpload}
                                    disabled={!selectedPropertyId || uploading}
                                >
                                    {uploading ? 'Wird hochgeladen...' : 'Bestätigen'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
}
