import { redirect } from 'next/navigation';

export default function ReviewRedirect() {
    redirect('/dashboard/warehouse/inbox?view=needs_review');
}
