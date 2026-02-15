'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, FileText, CheckCircle, AlertTriangle, Loader2, X } from 'lucide-react';
import { importCSVTransactions } from '@/lib/csv-import';

interface CSVUploadProps {
    bankAccountId: string;
    onSuccess?: () => void;
}

interface ImportResult {
    imported: number;
    duplicates: number;
    failed: number;
    total: number;
    format: string;
    errors: string[];
}

export default function CSVUpload({ bankAccountId, onSuccess }: CSVUploadProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [result, setResult] = useState<ImportResult | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = async (file: File) => {
        if (!file.name.endsWith('.csv')) {
            setResult({
                imported: 0,
                duplicates: 0,
                failed: 0,
                total: 0,
                format: 'unknown',
                errors: ['Bitte wählen Sie eine CSV-Datei aus.'],
            });
            return;
        }

        setSelectedFile(file);
        setResult(null);
    };

    const handleImport = async () => {
        if (!selectedFile) return;

        setIsImporting(true);
        setResult(null);

        try {
            const content = await selectedFile.text();
            const importResult = await importCSVTransactions(bankAccountId, content);
            setResult(importResult);
            if (importResult.imported > 0 && onSuccess) {
                onSuccess();
            }
        } catch (error) {
            setResult({
                imported: 0,
                duplicates: 0,
                failed: 0,
                total: 0,
                format: 'unknown',
                errors: [error instanceof Error ? error.message : 'Import fehlgeschlagen'],
            });
        } finally {
            setIsImporting(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    const reset = () => {
        setSelectedFile(null);
        setResult(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                    <Upload className="h-4 w-4" />
                    CSV-Import (Kontoauszug)
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Drop zone */}
                <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                    className={`
                        border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
                        ${isDragging
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }
                    `}
                >
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFile(file);
                        }}
                    />
                    {selectedFile ? (
                        <div className="flex items-center justify-center gap-2">
                            <FileText className="h-5 w-5 text-blue-600" />
                            <span className="text-sm font-medium">{selectedFile.name}</span>
                            <span className="text-xs text-muted-foreground">
                                ({(selectedFile.size / 1024).toFixed(1)} KB)
                            </span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    reset();
                                }}
                            >
                                <X className="h-3 w-3" />
                            </Button>
                        </div>
                    ) : (
                        <div>
                            <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">
                                CSV-Datei hierher ziehen oder klicken zum Auswählen
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Unterstützt: DKB, und andere deutsche Bankformate
                            </p>
                        </div>
                    )}
                </div>

                {/* Import button */}
                {selectedFile && !result && (
                    <Button
                        onClick={handleImport}
                        disabled={isImporting}
                        className="w-full"
                    >
                        {isImporting ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Importiere Buchungen…
                            </>
                        ) : (
                            <>
                                <Upload className="h-4 w-4 mr-2" />
                                CSV importieren
                            </>
                        )}
                    </Button>
                )}

                {/* Result display */}
                {result && (
                    <div className="space-y-2">
                        {result.imported > 0 && (
                            <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-md p-3">
                                <CheckCircle className="h-4 w-4 flex-shrink-0" />
                                <span className="text-sm">
                                    <strong>{result.imported}</strong> Buchungen importiert
                                </span>
                            </div>
                        )}
                        {result.duplicates > 0 && (
                            <div className="flex items-center gap-2 text-amber-700 bg-amber-50 rounded-md p-3">
                                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                                <span className="text-sm">
                                    <strong>{result.duplicates}</strong> Duplikate übersprungen
                                </span>
                            </div>
                        )}
                        {result.failed > 0 && (
                            <div className="flex items-center gap-2 text-red-700 bg-red-50 rounded-md p-3">
                                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                                <span className="text-sm">
                                    <strong>{result.failed}</strong> fehlgeschlagen
                                </span>
                            </div>
                        )}
                        {result.errors.length > 0 && (
                            <div className="text-xs text-red-600 bg-red-50 rounded-md p-2 space-y-1">
                                {result.errors.map((err, i) => (
                                    <div key={i}>{err}</div>
                                ))}
                            </div>
                        )}
                        {result.format !== 'unknown' && (
                            <p className="text-xs text-muted-foreground">
                                Format erkannt: {result.format === 'dkb_new' ? 'DKB (neu)' : result.format === 'dkb_old' ? 'DKB (alt)' : 'Generisch'}
                                {' · '}{result.total} Zeilen verarbeitet
                            </p>
                        )}
                        <Button variant="outline" size="sm" onClick={reset}>
                            Weitere Datei importieren
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
