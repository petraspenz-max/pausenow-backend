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
        const { action } = JSON.parse(event.body || '{}');
        
        if (action === 'send_pings') {
            // PHASE 1: Sende Pings an alle Kinder
            return await sendPingsToAllChildren(headers);
        } else if (action === 'check_responses') {
            // PHASE 2: Prüfe Antworten und warne Eltern
            return await checkResponsesAndAlert(headers);
        } else {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Action muss "send_pings" oder "check_responses" sein' })
            };
        }

    } catch (error) {
        console.error('PingCheck Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

async function sendPingsToAllChildren(headers) {
    const familiesSnapshot = await db.collection('families').get();
    let pingsSent = 0;
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            
            // Nur verbundene Kinder pingen
            if (child.fcmToken && child.isConnected) {
                try {
                    const pingId = `${Date.now()}_${childDoc.id}`;
                    
                    // Ping via FCM senden
                    await admin.messaging().send({
                        token: child.fcmToken,
                        data: {
                            action: 'ping',
                            pingId: pingId,
                            timestamp: Date.now().toString()
                        },
                        apns: {
                            headers: {
                                'apns-priority': '10',
                                'apns-push-type': 'alert'
                            },
                            payload: {
                                aps: {
                                    "mutable-content": 1,
                                    "content-available": 1
                                },
                                action: 'ping',
                                pingId: pingId
                            }
                        }
                    });
                    
                    // Ping-Zeitpunkt speichern
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childDoc.id)
                        .update({
                            lastPingSent: admin.firestore.FieldValue.serverTimestamp(),
                            lastPingId: pingId
                        });
                    
                    pingsSent++;
                    console.log(`Ping sent to ${child.name} (${childDoc.id})`);
                    
                } catch (error) {
                    console.error(`Failed to ping ${child.name}:`, error.message);
                }
            }
        }
    }
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            action: 'send_pings',
            pingsSent: pingsSent,
            timestamp: new Date().toISOString()
        })
    };
}

async function checkResponsesAndAlert(headers) {
    const familiesSnapshot = await db.collection('families').get();
    let trickstersFound = 0;
    
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const familyData = familyDoc.data();
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            
            // Nur verbundene Kinder prüfen
            if (!child.fcmToken || !child.isConnected) continue;
            if (!child.lastPingSent) continue;
            
            const pingSentTime = child.lastPingSent.toDate();
            const responseTime = child.lastPingResponse?.toDate();
            
            // Prüfen: Kam eine Antwort nach dem letzten Ping?
            const hasResponded = responseTime && responseTime > pingSentTime;
            const timeSincePing = Date.now() - pingSentTime.getTime();
            
            if (!hasResponded && timeSincePing > TIMEOUT_MS) {
                // TRICKSTER ERKANNT!
                console.log(`TRICKSTER: ${child.name} hat nicht geantwortet!`);
                trickstersFound++;
                
                // Kind als Trickster markieren und pausieren
                await db.collection('families').doc(familyId)
                    .collection('children').doc(childDoc.id)
                    .update({
                        tricksterBlocked: true,
                        tricksterBlockedAt: admin.firestore.FieldValue.serverTimestamp(),
                        isResponding: false,
                        isPaused: true
                    });
                
                // Alle Eltern warnen
                await alertAllParents(familyId, familyData, child);
            }
        }
    }
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            action: 'check_responses',
            trickstersFound: trickstersFound,
            timestamp: new Date().toISOString()
        })
    };
}

async function alertAllParents(familyId, familyData, child) {
    // Creator Token
    const parentTokens = [];
    if (familyData.creatorFCMToken) {
        parentTokens.push(familyData.creatorFCMToken);
    }
    
    // Partner Tokens
    if (familyData.partnerTokens && Array.isArray(familyData.partnerTokens)) {
        parentTokens.push(...familyData.partnerTokens);
    }
    
    for (const token of parentTokens) {
        try {
            await admin.messaging().send({
                token: token,
                notification: {
                    title: 'PauseNow',
                    body: `${child.name} hat versucht die Kontrolle zu umgehen und wurde pausiert.`
                },
                data: {
                    action: 'trickster_alert',
                    childId: child.id || '',
                    childName: child.name || ''
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1
                        }
                    }
                }
            });
            console.log(`Alert sent to parent: ${token.substring(0, 20)}...`);
        } catch (error) {
            console.error(`Failed to alert parent:`, error.message);
        }
    }
}
