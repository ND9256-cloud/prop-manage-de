
import SideNav from '@/components/dashboard/sidenav';
import { TooltipProvider } from '@/components/ui/tooltip';

export default function Layout({ children }: { children: React.ReactNode }) {
    return (
        <TooltipProvider>
            <div className="flex h-full flex-col md:flex-row overflow-hidden">
                <div className="shrink-0 h-full">
                    <SideNav />
                </div>
                <main className="flex-1 overflow-y-auto p-6 md:p-12">{children}</main>
            </div>
        </TooltipProvider>
    );
}
