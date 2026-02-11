
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
import { createLease } from '@/lib/lease-actions';

interface LeaseFormProps {
    children: React.ReactNode;
    unitId: string;
    propertyId: string;
    persons: { id: string; firstName: string; lastName: string }[];
}

export default function LeaseForm({ children, unitId, propertyId, persons }: LeaseFormProps) {
    const [open, setOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (formData: FormData) => {
        setIsSubmitting(true);
        try {
            formData.set('unitId', unitId);
            await createLease(formData);
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
                    <DialogTitle>Neuen Mietvertrag erstellen</DialogTitle>
                </DialogHeader>
                <form action={handleSubmit} className="space-y-4">
                    <div>
                        <Label htmlFor="mainTenantId">Hauptmieter</Label>
                        <Select name="mainTenantId" required>
                            <SelectTrigger>
                                <SelectValue placeholder="Mieter wählen" />
                            </SelectTrigger>
                            <SelectContent>
                                {persons.map(p => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.firstName} {p.lastName}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="startDate">Mietbeginn</Label>
                            <Input id="startDate" name="startDate" type="date" required />
                        </div>
                        <div>
                            <Label htmlFor="endDate">Mietende (optional)</Label>
                            <Input id="endDate" name="endDate" type="date" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="coldRent">Kaltmiete (€)</Label>
                            <Input
                                id="coldRent"
                                name="coldRent"
                                type="number"
                                step="0.01"
                                placeholder="850.00"
                                required
                            />
                        </div>
                        <div>
                            <Label htmlFor="utilityAdvance">Nebenkosten-VZ (€)</Label>
                            <Input
                                id="utilityAdvance"
                                name="utilityAdvance"
                                type="number"
                                step="0.01"
                                placeholder="200.00"
                                required
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="deposit">Kaution (€)</Label>
                            <Input
                                id="deposit"
                                name="deposit"
                                type="number"
                                step="0.01"
                                placeholder="2550.00"
                                required
                            />
                        </div>
                        <div>
                            <Label htmlFor="parkingRent">Stellplatz (€)</Label>
                            <Input
                                id="parkingRent"
                                name="parkingRent"
                                type="number"
                                step="0.01"
                                placeholder="50.00"
                            />
                        </div>
                    </div>
                    <Button type="submit" className="w-full" disabled={isSubmitting}>
                        {isSubmitting ? 'Erstellen...' : 'Mietvertrag erstellen'}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}
