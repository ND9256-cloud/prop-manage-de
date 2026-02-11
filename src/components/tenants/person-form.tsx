
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
import { createPerson } from '@/lib/lease-actions';

interface PersonFormProps {
    children: React.ReactNode;
    person?: {
        id: string;
        firstName: string;
        lastName: string;
        email: string | null;
        phone: string | null;
    };
}

export default function PersonForm({ children, person }: PersonFormProps) {
    const [open, setOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const isEdit = !!person;

    const handleSubmit = async (formData: FormData) => {
        setIsSubmitting(true);
        try {
            await createPerson(formData);
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
                    <DialogTitle>{isEdit ? 'Person bearbeiten' : 'Neue Person anlegen'}</DialogTitle>
                </DialogHeader>
                <form action={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label htmlFor="firstName">Vorname</Label>
                            <Input
                                id="firstName"
                                name="firstName"
                                placeholder="Max"
                                defaultValue={person?.firstName}
                                required
                            />
                        </div>
                        <div>
                            <Label htmlFor="lastName">Nachname</Label>
                            <Input
                                id="lastName"
                                name="lastName"
                                placeholder="Mustermann"
                                defaultValue={person?.lastName}
                                required
                            />
                        </div>
                    </div>
                    <div>
                        <Label htmlFor="email">E-Mail</Label>
                        <Input
                            id="email"
                            name="email"
                            type="email"
                            placeholder="max@example.com"
                            defaultValue={person?.email || ''}
                        />
                    </div>
                    <div>
                        <Label htmlFor="phone">Telefon</Label>
                        <Input
                            id="phone"
                            name="phone"
                            placeholder="+49 123 456789"
                            defaultValue={person?.phone || ''}
                        />
                    </div>
                    <Button type="submit" className="w-full" disabled={isSubmitting}>
                        {isSubmitting ? 'Speichern...' : (isEdit ? 'Aktualisieren' : 'Anlegen')}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}
