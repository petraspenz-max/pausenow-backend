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

// Build 180: Alert-Push an die Eltern, wenn die Bildschirmzeit-Freigabe beim Kind fehlt.
// Format gespiegelt von sendPush.js (trickster_alert): sichtbarer Alert, loc-key -> iOS
// uebersetzt on-device via Localizable. Direkter Versand (kein zweiter Funktions-Hop),
// damit die Warnung nicht an einer anderen Funktion haengt.
// Rueckgabe: true, sobald mind. ein Push zugestellt wurde.
async function sendPermissionLostPush(parentTokens, childId, childName) {
    let anySuccess = false;
    for (const token of parentTokens) {
        if (!token) continue;
        try {
            await admin.messaging().send({
                token: token,
                data: {
                    action: 'permission_lost',
                    childId: childId || '',
                    childName: childName || '',
                    timestamp: Date.now().toString()
                },
                apns: {
                    headers: {
                        'apns-priority': '10',
                        'apns-push-type': 'alert'
                    },
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                            alert: {
                                title: 'PauseNow',
                                'loc-key': 'permission_lost_message',
                                'loc-args': [childName || 'Kind']
                            }
                        }
                    }
                },
                android: {
                    priority: 'high',
                    notification: {
                        title: 'PauseNow',
                        body: `${childName || 'Kind'}: Bildschirmzeit-Freigabe fehlt.`
                    },
                    data: {
                        action: 'permission_lost',
                        childId: childId || '',
                        childName: childName || ''
                    }
                }
            });
            anySuccess = true;
        } catch (err) {
            console.error(`permission_lost push failed (${String(token).substring(0, 20)}...):`, err.code || err.message);
        }
    }
    return anySuccess;
}

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
        const { familyId, childId, respondedAt, permissionOK } = JSON.parse(event.body);
        if (!familyId || !childId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'familyId und childId erforderlich' })
            };
        }
        const childRef = db.collection('families').doc(familyId)
            .collection('children').doc(childId);

        // Build 180: aktuellen Stand lesen (Eltern-Tokens, Name, Dedup-Flag)
        const snap = await childRef.get();
        const cur = snap.exists ? snap.data() : {};
        const wasAlertActive = cur.permissionAlertActive === true;
        const parentTokens = Array.isArray(cur.connectedParentTokens) ? cur.connectedParentTokens : [];
        const childName = cur.name || 'Kind';

        // Ping-Antwort in Firestore speichern
        const updateData = {
            lastPingResponse: admin.firestore.FieldValue.serverTimestamp(),
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            isResponding: true
        };
        // Build 179: permissionOK nur schreiben, wenn im Payload enthalten
        // (alte NSE-Versionen senden es nicht -> Feld unangetastet lassen).
        if (typeof permissionOK === 'boolean') {
            updateData.permissionOK = permissionOK;
        }

// Build 181 (Fix): Push beim UEBERGANG nach false — unabhaengig davon,
        // welcher Pfad den alten Wert gesetzt hat (Vordergrund-Report ODER Ping).
        // Der permissionOK-Wert im Doc IST die Dedup-Quelle (kein Flag mehr).
        // Bug in 180: der Vordergrund-Report (Build 177) schreibt permissionOK
        // direkt und setzte das permissionAlertActive-Flag nicht zurueck -> nach
        // einer Wiederherstellung im Vordergrund blieb es true und ein erneuter
        // Verlust loeste keinen Push aus.
        const prevPermissionOK = cur.permissionOK;  // true | false | undefined
        if (permissionOK === false && prevPermissionOK !== false && parentTokens.length > 0) {
            await sendPermissionLostPush(parentTokens, childId, childName);
        }

        await childRef.update(updateData);
        
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
