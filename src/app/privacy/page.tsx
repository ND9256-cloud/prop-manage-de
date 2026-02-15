export const metadata = {
    title: 'Datenschutzerklärung – PropManager DE',
    description: 'Datenschutzerklärung der PropManager DE Anwendung',
};

export default function PrivacyPage() {
    return (
        <main className="max-w-3xl mx-auto px-6 py-16">
            <h1 className="text-3xl font-bold mb-2">Datenschutzerklärung</h1>
            <p className="text-sm text-gray-500 mb-8">Stand: Februar 2025</p>

            <div className="prose prose-gray max-w-none space-y-6">
                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">1. Verantwortlicher</h2>
                    <p>Demo Property Management GmbH<br />Musterstraße 1<br />34117 Kassel<br />Deutschland</p>
                    <p>E-Mail: datenschutz@propmanager.de</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">2. Erhebung und Verarbeitung personenbezogener Daten</h2>
                    <p>Wir verarbeiten personenbezogene Daten nur, soweit dies zur Bereitstellung unserer Hausverwaltungs-Plattform erforderlich ist. Hierzu gehören:</p>
                    <ul className="list-disc pl-6 space-y-1 mt-2">
                        <li>Name und Kontaktdaten (E-Mail-Adresse)</li>
                        <li>Bankverbindungsdaten (IBAN, Kontoinhaber) über den Open-Banking-Dienst Enable Banking</li>
                        <li>Kontotransaktionsdaten zur Mietüberwachung</li>
                        <li>Immobilien- und Mietvertragsdaten</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">3. Open Banking (PSD2)</h2>
                    <p>Für die Anbindung von Bankkonten nutzen wir den Dienst <strong>Enable Banking</strong> (Enable Banking Oy, Finnland). Die Verbindung erfolgt über die PSD2-Schnittstelle Ihrer Bank. Dabei werden folgende Daten abgerufen:</p>
                    <ul className="list-disc pl-6 space-y-1 mt-2">
                        <li>Kontoinformationen (IBAN, Kontoinhaber)</li>
                        <li>Kontostände</li>
                        <li>Transaktionsdaten (Buchungsdatum, Betrag, Verwendungszweck, Auftraggeber/Empfänger)</li>
                    </ul>
                    <p className="mt-2">Der Zugriff erfolgt ausschließlich lesend (AIS – Account Information Service). Es werden keine Zahlungen initiiert. Die Einwilligung kann jederzeit über die Anwendung oder direkt bei Ihrer Bank widerrufen werden.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">4. Rechtsgrundlage</h2>
                    <p>Die Verarbeitung erfolgt auf Grundlage Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) sowie zur Erfüllung des Nutzungsvertrags (Art. 6 Abs. 1 lit. b DSGVO).</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">5. Datenspeicherung und -löschung</h2>
                    <p>Ihre Daten werden auf Servern innerhalb der EU gespeichert. Transaktionsdaten werden für die Dauer der Kontoverbindung gespeichert und können jederzeit gelöscht werden. Nach Beendigung der Nutzung werden alle personenbezogenen Daten innerhalb von 30 Tagen gelöscht.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">6. Ihre Rechte</h2>
                    <p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch. Kontaktieren Sie uns unter datenschutz@propmanager.de.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">7. Kontakt</h2>
                    <p>Bei Fragen zum Datenschutz wenden Sie sich bitte an:<br />datenschutz@propmanager.de</p>
                </section>
            </div>
        </main>
    );
}
