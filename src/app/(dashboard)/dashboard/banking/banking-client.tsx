'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import BankSelector from '@/components/banking/bank-selector';

export default function BankingPageClient() {
    const [selectorOpen, setSelectorOpen] = useState(false);

    return (
        <>
            <Button onClick={() => setSelectorOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Konto verbinden
            </Button>
            <BankSelector open={selectorOpen} onOpenChange={setSelectorOpen} />
        </>
    );
}
