
'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, FileText, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Message {
    role: 'user' | 'assistant';
    content: string;
    sources?: { documentName: string; documentId: string }[];
}

interface DocumentChatProps {
    propertyId?: string;
    propertyName?: string;
    onAskQuestion: (question: string) => Promise<{
        answer: string;
        sources: { documentName: string; documentId: string; content: string }[];
    }>;
    suggestedQuestions?: string[];
}

export default function DocumentChat({
    propertyId,
    propertyName,
    onAskQuestion,
    suggestedQuestions = [],
}: DocumentChatProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Scroll to bottom when new messages arrive
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSubmit = async (question: string) => {
        if (!question.trim() || isLoading) return;

        const userMessage: Message = { role: 'user', content: question };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            const response = await onAskQuestion(question);

            const assistantMessage: Message = {
                role: 'assistant',
                content: response.answer,
                sources: response.sources,
            };
            setMessages(prev => [...prev, assistantMessage]);
        } catch (error) {
            const errorMessage: Message = {
                role: 'assistant',
                content: 'Es ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.',
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Card className="flex flex-col h-[600px]">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-purple-500" />
                    Dokument-Assistent
                    {propertyName && <span className="text-muted-foreground font-normal">- {propertyName}</span>}
                </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col overflow-hidden">
                {/* Messages */}
                <ScrollArea className="flex-1 pr-4" ref={scrollRef}>
                    {messages.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-4">
                            <Sparkles className="h-12 w-12 text-purple-500/50 mb-4" />
                            <h3 className="font-semibold text-lg mb-2">Fragen Sie Ihre Dokumente</h3>
                            <p className="text-muted-foreground text-sm mb-6">
                                Stellen Sie Fragen zu Ihren hochgeladenen Dokumenten und erhalten Sie sofort Antworten mit Quellenangaben.
                            </p>

                            {/* Suggested questions */}
                            {suggestedQuestions.length > 0 && (
                                <div className="flex flex-wrap gap-2 justify-center">
                                    {suggestedQuestions.map((question, index) => (
                                        <Button
                                            key={index}
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleSubmit(question)}
                                            className="text-xs"
                                        >
                                            {question}
                                        </Button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-4 py-4">
                            {messages.map((message, index) => (
                                <div
                                    key={index}
                                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[80%] rounded-lg p-3 ${message.role === 'user'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted'
                                            }`}
                                    >
                                        <div className="whitespace-pre-wrap">{message.content}</div>

                                        {/* Sources */}
                                        {message.sources && message.sources.length > 0 && (
                                            <div className="mt-3 pt-3 border-t border-border/50">
                                                <p className="text-xs font-medium mb-2 opacity-70">Quellen:</p>
                                                <div className="flex flex-wrap gap-1">
                                                    {message.sources.map((source, i) => (
                                                        <span
                                                            key={i}
                                                            className="inline-flex items-center gap-1 text-xs bg-background/50 rounded px-2 py-1"
                                                        >
                                                            <FileText className="h-3 w-3" />
                                                            {source.documentName}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}

                            {isLoading && (
                                <div className="flex justify-start">
                                    <div className="bg-muted rounded-lg p-3">
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </ScrollArea>

                {/* Input */}
                <div className="mt-4 flex gap-2">
                    <Input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Stellen Sie eine Frage zu Ihren Dokumenten..."
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit(input);
                            }
                        }}
                        disabled={isLoading}
                    />
                    <Button
                        onClick={() => handleSubmit(input)}
                        disabled={!input.trim() || isLoading}
                    >
                        <Send className="h-4 w-4" />
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
