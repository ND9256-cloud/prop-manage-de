import { Mail, MessageCircle, Monitor } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n/warehouse';

const SOURCE_CONFIG = {
    email: {
        icon: Mail,
        label: t.viaEmail,
    },
    telegram: {
        icon: MessageCircle,
        label: t.viaTelegram,
    },
    ui: {
        icon: Monitor,
        label: t.webUpload,
    },
} as const;

interface SourceIconProps {
    source: 'email' | 'telegram' | 'ui';
}

export function SourceIcon({ source }: SourceIconProps) {
    const config = SOURCE_CONFIG[source] ?? SOURCE_CONFIG.ui;
    const Icon = config.icon;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex items-center text-muted-foreground">
                    <Icon className="h-4 w-4" />
                </span>
            </TooltipTrigger>
            <TooltipContent>
                <p>{config.label.de}</p>
            </TooltipContent>
        </Tooltip>
    );
}
