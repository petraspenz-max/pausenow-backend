const admin = require('firebase-admin');

// Firebase Admin SDK initialisieren
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'pausenow-daae2'
    });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    // Security Check
    const API_KEY = process.env.PAUSENOW_API_KEY || 'dev-key-pausenow-2025';
    const requestKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];

    if (!requestKey || requestKey !== API_KEY) {
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Unauthorized' })
        };
    }

    try {
        const { familyId, childId, respondedAt } = JSON.parse(event.body);

        if (!familyId || !childId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'familyId und childId erforderlich' })
            };
        }

        // Ping-Antwort in Firestore speichern
// WICHTIG: tricksterBlocked wird NICHT zurueckgesetzt!
        // Nur das Kind-Geraet selbst (nach Einstellungs-Check) oder
        // die Eltern (per Aktivierung) duerfen tricksterBlocked aendern.
        // Ein Ping-Response beweist nur, dass die App laeuft - nicht
        // dass die Einstellungen korrekt sind.
        await db.collection('families').doc(familyId)
            .collection('children').doc(childId)
            .update({
                lastPingResponse: admin.firestore.FieldValue.serverTimestamp(),
                isResponding: true
            });

        console.log(`Ping response from child ${childId} in family ${familyId}`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Ping response recorded',
                timestamp: new Date().toISOString()
            })
        };

    } catch (error) {
        console.error('Ping Response Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
