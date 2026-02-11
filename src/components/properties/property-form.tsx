
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { createProperty, updateProperty } from '@/lib/property-actions';

interface PropertyFormProps {
    children: React.ReactNode;
    property?: {
        id: string;
        name: string;
        address: string;
        city: string;
        zip: string;
        type: string;
        yearBuilt: number | null;
    };
}

export default function PropertyForm({ children, property }: PropertyFormProps) {
    const [open, setOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const isEdit = !!property;

    const handleSubmit = async (formData: FormData) => {
        setIsSubmitting(true);
        try {
            if (isEdit) {
                await updateProperty(property.id, formData);
            } else {
                await createProperty(formData);
            }
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
                    <DialogTitle>{isEdit ? 'Immobilie bearbeiten' : 'Neue Immobilie erstellen'}</DialogTitle>
                </DialogHeader>
                <form action={handleSubmit} className="space-y-4">
                    <div>
                        <Label htmlFor="name">Name</Label>
                        <Input
                            id="name"
                            name="name"
                            placeholder="z.B. Musterstraße 123"
                            defaultValue={property?.name}
                            required
                        />
                    </div>
                    <div>
                        <Label htmlFor="address">Adresse</Label>
                        <Input
                            id="address"
                            name="address"
                            placeholder="Straße und Hausnummer"
                            defaultValue={property?.address}
                            required
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="zip">PLZ</Label>
                            <Input
                                id="zip"
                                name="zip"
                                placeholder="12345"
                                defaultValue={property?.zip}
                                required
                            />
                        </div>
                        <div>
                            <Label htmlFor="city">Stadt</Label>
                            <Input
                                id="city"
                                name="city"
                                placeholder="Berlin"
                                defaultValue={property?.city}
                                required
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="type">Immobilientyp</Label>
                            <Select name="type" defaultValue={property?.type || 'APARTMENT_BUILDING'}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Typ wählen" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="APARTMENT_BUILDING">Mehrfamilienhaus</SelectItem>
                                    <SelectItem value="SINGLE_FAMILY_HOME">Einfamilienhaus</SelectItem>
                                    <SelectItem value="MIXED_USE">Wohn- und Geschäftshaus</SelectItem>
                                    <SelectItem value="COMMERCIAL">Gewerbe</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label htmlFor="yearBuilt">Baujahr</Label>
                            <Input
                                id="yearBuilt"
                                name="yearBuilt"
                                type="number"
                                placeholder="1990"
                                defaultValue={property?.yearBuilt || ''}
                            />
                        </div>
                    </div>
                    <Button type="submit" className="w-full" disabled={isSubmitting}>
                        {isSubmitting ? 'Speichern...' : (isEdit ? 'Aktualisieren' : 'Erstellen')}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}
