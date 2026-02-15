export const metadata = {
    title: 'Nutzungsbedingungen – PropManager DE',
    description: 'Nutzungsbedingungen der PropManager DE Anwendung',
};

export default function TermsPage() {
    return (
        <main className="max-w-3xl mx-auto px-6 py-16">
            <h1 className="text-3xl font-bold mb-2">Nutzungsbedingungen</h1>
            <p className="text-sm text-gray-500 mb-8">Stand: Februar 2025</p>

            <div className="prose prose-gray max-w-none space-y-6">
                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">1. Geltungsbereich</h2>
                    <p>Diese Nutzungsbedingungen gelten für die Nutzung der Anwendung PropManager DE, betrieben von der Demo Property Management GmbH, Musterstraße 1, 34117 Kassel.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">2. Leistungsbeschreibung</h2>
                    <p>PropManager DE ist eine Plattform zur digitalen Hausverwaltung. Die Anwendung bietet insbesondere:</p>
                    <ul className="list-disc pl-6 space-y-1 mt-2">
                        <li>Verwaltung von Immobilien, Einheiten und Mietverträgen</li>
                        <li>Mietübersicht und Mietspiegel (Rent Roll)</li>
                        <li>Anbindung von Bankkonten über Open Banking (PSD2) zur automatischen Transaktionsübersicht</li>
                        <li>Dokumentenverwaltung</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">3. Bankverbindung (Open Banking)</h2>
                    <p>Die Anbindung von Bankkonten erfolgt über den PSD2-konformen Dienst Enable Banking. Durch die Verbindung gestatten Sie der Anwendung den lesenden Zugriff auf Kontoinformationen und Transaktionsdaten. Es werden keine Zahlungen ausgelöst.</p>
                    <p className="mt-2">Sie können die Bankverbindung jederzeit über die Anwendung oder direkt bei Ihrer Bank trennen.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">4. Pflichten des Nutzers</h2>
                    <ul className="list-disc pl-6 space-y-1 mt-2">
                        <li>Der Nutzer ist für die Geheimhaltung seiner Zugangsdaten verantwortlich.</li>
                        <li>Die Nutzung der Plattform erfolgt ausschließlich für eigene, rechtmäßige Hausverwaltungszwecke.</li>
                        <li>Der Nutzer stellt sicher, dass die eingegebenen Daten korrekt und aktuell sind.</li>
                    </ul>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">5. Haftung</h2>
                    <p>Die Anwendung wird &quot;wie besehen&quot; bereitgestellt. Für die Richtigkeit und Vollständigkeit der über Open Banking abgerufenen Bankdaten übernehmen wir keine Gewähr. Die Haftung für leicht fahrlässige Pflichtverletzungen ist ausgeschlossen, sofern keine wesentlichen Vertragspflichten betroffen sind.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">6. Kündigung</h2>
                    <p>Das Nutzungsverhältnis kann von beiden Seiten jederzeit ohne Angabe von Gründen beendet werden. Bei Kündigung werden alle gespeicherten Daten gemäß unserer Datenschutzerklärung gelöscht.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">7. Anwendbares Recht</h2>
                    <p>Es gilt das Recht der Bundesrepublik Deutschland. Gerichtsstand ist Kassel.</p>
                </section>

                <section>
                    <h2 className="text-xl font-semibold mt-8 mb-3">8. Kontakt</h2>
                    <p>Bei Fragen zu diesen Nutzungsbedingungen:<br />info@propmanager.de</p>
                </section>
            </div>
        </main>
    );
}
