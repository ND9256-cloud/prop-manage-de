import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
    return (
        <div className="space-y-6" data-testid="warehouse-loading">
            <div className="flex items-center divide-x divide-border rounded-lg border border-border bg-card px-2 py-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex-1 text-center px-4 space-y-1.5">
                        <Skeleton className="h-5 w-16 mx-auto" />
                        <Skeleton className="h-3 w-20 mx-auto" />
                    </div>
                ))}
            </div>

            <div>
                <Skeleton className="h-5 w-32 mb-3" />
                <div className="rounded-md border p-4 space-y-3">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                </div>
            </div>

            <div>
                <Skeleton className="h-5 w-40 mb-3" />
                <div className="rounded-md border p-4 space-y-3">
                    <div className="flex justify-between">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-4 w-16" />
                    </div>
                    <Skeleton className="h-px w-full" />
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center justify-between">
                            <Skeleton className="h-5 w-12" />
                            <Skeleton className="h-5 w-20" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
