'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Loader2, MessageSquare } from 'lucide-react';

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export function PropertyChat({ propertyId }: { propertyId: string }) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [stale, setStale] = useState(false);
    const [open, setOpen] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    async function handleSend() {
        const question = input.trim();
        if (!question || loading) return;

        setInput('');
        setMessages((prev) => [...prev, { role: 'user', content: question }]);
        setLoading(true);
        setStale(false);

        try {
            const res = await fetch(`/api/properties/${propertyId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question }),
            });

            const data = await res.json();

            if (!res.ok) {
                setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', content: data.error ?? 'Ein Fehler ist aufgetreten.' },
                ]);
                return;
            }

            if (data.stale) setStale(true);
            setMessages((prev) => [...prev, { role: 'assistant', content: data.answer }]);
        } catch {
            setMessages((prev) => [
                ...prev,
                { role: 'assistant', content: 'Verbindungsfehler. Bitte erneut versuchen.' },
            ]);
        } finally {
            setLoading(false);
        }
    }

    if (!open) {
        return (
            <div className="fixed bottom-6 right-6 z-50">
                <Button
                    onClick={() => setOpen(true)}
                    size="lg"
                    className="rounded-full h-14 w-14 shadow-lg"
                >
                    <MessageSquare className="h-6 w-6" />
                </Button>
            </div>
        );
    }

    return (
        <div className="fixed bottom-6 right-6 z-50 w-[420px] flex flex-col bg-background border rounded-xl shadow-xl overflow-hidden"
             style={{ maxHeight: 'min(600px, calc(100vh - 100px))' }}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
                <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium text-sm">Immobilien-Assistent</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)} className="h-7 w-7 p-0">
                    ✕
                </Button>
            </div>

            {/* Stale banner */}
            {stale && (
                <div className="px-4 py-2 bg-yellow-50 border-b border-yellow-200 text-yellow-800 text-xs">
                    Die Analyse wird aktualisiert.
                </div>
            )}

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[200px]">
                {messages.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center pt-8">
                        Stellen Sie eine Frage zu dieser Immobilie.
                    </p>
                )}
                {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div
                            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                                msg.role === 'user'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-muted text-foreground'
                            }`}
                        >
                            {msg.content}
                        </div>
                    </div>
                ))}
                {loading && (
                    <div className="flex justify-start">
                        <div className="bg-muted rounded-lg px-3 py-2">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                    </div>
                )}
            </div>

            {/* Input */}
            <div className="border-t p-3">
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSend();
                    }}
                    className="flex gap-2"
                >
                    <Textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                        placeholder="Frage zur Immobilie stellen..."
                        className="min-h-[40px] max-h-[120px] resize-none text-sm"
                        rows={1}
                        disabled={loading}
                    />
                    <Button type="submit" size="icon" disabled={loading || !input.trim()} className="shrink-0">
                        <Send className="h-4 w-4" />
                    </Button>
                </form>
            </div>
        </div>
    );
}
