'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Upload } from 'lucide-react';
import RentRollImport from '@/components/rent-roll/rent-roll-import';

export default function ImportButton() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <Upload className="h-4 w-4 mr-2" />
                Import
            </Button>
            {open && <RentRollImport onClose={() => { setOpen(false); window.location.reload(); }} />}
        </>
    );
}
