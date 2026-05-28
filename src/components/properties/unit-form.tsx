
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { createUnit, updateUnit, deleteUnit } from '@/lib/property-actions';
import { Trash2 } from 'lucide-react';

interface UnitFormProps {
    children: React.ReactNode;
    propertyId: string;
    unit?: {
        id: string;
        unitNumber: string;
        floor: number | null;
        sizeSqm: number | null;
        rooms: number | null;
        targetColdRent: number | null;
    };
}

export default function UnitForm({ children, propertyId, unit }: UnitFormProps) {
    const [open, setOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const isEdit = !!unit;

    const handleSubmit = async (formData: FormData) => {
        setIsSubmitting(true);
        try {
            formData.set('propertyId', propertyId);
            if (isEdit) {
                await updateUnit(unit.id, formData);
            } else {
                await createUnit(formData);
            }
            setOpen(false);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async () => {
        if (!unit || !confirm('Einheit wirklich löschen?')) return;
        setIsSubmitting(true);
        try {
            await deleteUnit(unit.id);
            setOpen(false);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{children}</DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Einheit bearbeiten' : 'Neue Einheit erstellen'}</DialogTitle>
                </DialogHeader>
                <form action={handleSubmit} className="space-y-4">
                    <div>
                        <Label htmlFor="unitNumber">Einheitsnummer</Label>
                        <Input
                            id="unitNumber"
                            name="unitNumber"
                            placeholder="z.B. Whg. 1 oder Top 12"
                            defaultValue={unit?.unitNumber}
                            required
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="sizeSqm">Fläche (m²)</Label>
                            <Input
                                id="sizeSqm"
                                name="sizeSqm"
                                type="number"
                                step="0.1"
                                placeholder="75.5"
                                defaultValue={unit?.sizeSqm ?? ''}
                                required
                            />
                        </div>
                        <div>
                            <Label htmlFor="rooms">Zimmer</Label>
                            <Input
                                id="rooms"
                                name="rooms"
                                type="number"
                                step="0.5"
                                placeholder="3.5"
                                defaultValue={unit?.rooms || ''}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="floor">Etage</Label>
                            <Input
                                id="floor"
                                name="floor"
                                type="number"
                                placeholder="2"
                                defaultValue={unit?.floor || ''}
                            />
                        </div>
                        <div>
                            <Label htmlFor="targetColdRent">Ziel-Kaltmiete (€)</Label>
                            <Input
                                id="targetColdRent"
                                name="targetColdRent"
                                type="number"
                                step="0.01"
                                placeholder="850.00"
                                defaultValue={unit?.targetColdRent || ''}
                            />
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button type="submit" className="flex-1" disabled={isSubmitting}>
                            {isSubmitting ? 'Speichern...' : (isEdit ? 'Aktualisieren' : 'Erstellen')}
                        </Button>
                        {isEdit && (
                            <Button
                                type="button"
                                variant="outline"
                                className="text-red-600"
                                onClick={handleDelete}
                                disabled={isSubmitting}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
