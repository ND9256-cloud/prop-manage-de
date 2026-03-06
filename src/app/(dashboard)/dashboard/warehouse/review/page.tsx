
import { auth } from '@/auth';
import { notFound } from 'next/navigation';
import { getReviewTasks, getProperties } from '@/lib/warehouse-actions';
import ReviewQueue from '@/components/warehouse/review-queue';

export default async function ReviewPage() {
    const session = await auth();
    if (!session?.user?.email) {
        notFound();
    }

    const [reviewResult, properties] = await Promise.all([
        getReviewTasks(),
        getProperties(),
    ]);

    return (
        <ReviewQueue
            initialTasks={reviewResult.tasks as Parameters<typeof ReviewQueue>[0]['initialTasks']}
            properties={properties}
        />
    );
}
