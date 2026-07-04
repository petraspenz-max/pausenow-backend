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

// Build 181 (Fix): Alert-Push an die Eltern, wenn die Bildschirmzeit-Freigabe fehlt.
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

        // Aktuellen Stand lesen (Eltern-Tokens, Name, vorheriger permissionOK)
        const snap = await childRef.get();
        const cur = snap.exists ? snap.data() : {};
        const parentTokens = Array.isArray(cur.connectedParentTokens) ? cur.connectedParentTokens : [];
        const childName = cur.name || 'Kind';
        const prevPermissionOK = cur.permissionOK;  // true | false | undefined

        // Ping-Antwort in Firestore speichern
        const updateData = {
            lastPingResponse: admin.firestore.FieldValue.serverTimestamp(),
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            isResponding: true
        };
        if (typeof permissionOK === 'boolean') {
            updateData.permissionOK = permissionOK;
        }

        // Build 181 (Fix): Push NUR beim echten Uebergang nach false — egal, welcher
        // Pfad (Vordergrund-Report ODER Ping) den alten Wert gesetzt hat.
        // permissionOK im Doc IST die Dedup-Quelle (kein Flag mehr).
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
