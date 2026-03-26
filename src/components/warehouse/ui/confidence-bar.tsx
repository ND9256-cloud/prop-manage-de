import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ConfidenceBarProps {
    score: number; // 0-100
}

function getBarColor(score: number) {
    if (score >= 85) return 'bg-green-500';
    if (score >= 50) return 'bg-amber-500';
    return 'bg-red-500';
}

function getLabelColor(score: number) {
    if (score >= 85) return 'text-green-700';
    if (score >= 50) return 'text-amber-700';
    return 'text-red-600';
}

export function ConfidenceBar({ score }: ConfidenceBarProps) {
    const barColor = getBarColor(score);
    const labelColor = getLabelColor(score);
    const isLow = score < 50;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex w-full min-w-[100px] flex-col gap-1">
                    {/* Progress bar */}
                    <div className="h-1.5 w-full rounded-full bg-muted">
                        <div
                            className={`h-1.5 rounded-full transition-all ${barColor}`}
                            style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
                        />
                    </div>
                    <span className={`text-xs font-medium ${labelColor}`}>
                        {isLow ? 'Niedrig' : `${Math.round(score)}%`}
                    </span>
                </div>
            </TooltipTrigger>
            <TooltipContent>
                <p>Konfidenz</p>
            </TooltipContent>
        </Tooltip>
    );
}
