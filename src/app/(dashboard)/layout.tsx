
import SideNav from '@/components/dashboard/sidenav';
import { TooltipProvider } from '@/components/ui/tooltip';

export default function Layout({ children }: { children: React.ReactNode }) {
    return (
        <TooltipProvider>
            <div className="flex h-screen flex-col md:flex-row md:overflow-hidden">
                <div className="flex-none">
                    <SideNav />
                </div>
                <div className="flex-grow p-6 md:overflow-y-auto md:p-12">{children}</div>
            </div>
        </TooltipProvider>
    );
}
