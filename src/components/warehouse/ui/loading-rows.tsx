import { Skeleton } from '@/components/ui/skeleton';
import { TableBody, TableCell, TableRow } from '@/components/ui/table';

interface LoadingRowsProps {
    rows?: number;
    cols?: number;
}

const COL_WIDTHS = ['w-48', 'w-24', 'w-28', 'w-24', 'w-28', 'w-24', 'w-10'];

export function LoadingRows({ rows = 5, cols = 7 }: LoadingRowsProps) {
    return (
        <TableBody>
            {Array.from({ length: rows }).map((_, rowIdx) => (
                <TableRow key={rowIdx}>
                    {/* Checkbox column */}
                    <TableCell className="py-3 px-4">
                        <Skeleton className="h-4 w-4 rounded" />
                    </TableCell>
                    {Array.from({ length: cols }).map((_, colIdx) => (
                        <TableCell key={colIdx} className="py-3 px-4">
                            <Skeleton className={`h-4 ${COL_WIDTHS[colIdx] ?? 'w-20'} rounded`} />
                            {colIdx === 0 && (
                                <Skeleton className="mt-1 h-3 w-32 rounded" />
                            )}
                        </TableCell>
                    ))}
                </TableRow>
            ))}
        </TableBody>
    );
}
