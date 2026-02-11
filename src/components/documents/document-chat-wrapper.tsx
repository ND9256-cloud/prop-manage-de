
'use client';

import DocumentChat from '@/components/documents/document-chat';

interface DocumentChatWrapperProps {
    propertyId: string;
    propertyName: string;
    suggestedQuestions: string[];
    onAskQuestion: (question: string) => Promise<{
        answer: string;
        sources: { documentName: string; documentId: string; content: string }[];
    }>;
}

export default function DocumentChatWrapper({
    propertyId,
    propertyName,
    suggestedQuestions,
    onAskQuestion,
}: DocumentChatWrapperProps) {
    return (
        <DocumentChat
            propertyId={propertyId}
            propertyName={propertyName}
            suggestedQuestions={suggestedQuestions}
            onAskQuestion={onAskQuestion}
        />
    );
}
