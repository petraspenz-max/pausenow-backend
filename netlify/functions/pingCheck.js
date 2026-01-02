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
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Scheduled functions kommen ohne Auth - das ist OK
    const isScheduled = !event.body || event.body === '';

    try {
        console.log('PingCheck started - isScheduled:', isScheduled);
        
        // PHASE 1: Prüfe alte Pings und warne bei Timeout
        const checkResult = await checkResponsesAndAlert();
        
        // PHASE 2: Sende neue Pings
        const pingResult = await sendPingsToAllChildren();
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                pingsSent: pingResult.pingsSent,
                trickstersFound: checkResult.trickstersFound,
                timestamp: new Date().toISOString()
            })
        };

    } catch (error) {
        console.error('PingCheck Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

async function sendPingsToAllChildren() {
    const familiesSnapshot = await db.collection('families').get();
    let pingsSent = 0;
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            
            if (child.fcmToken && child.isConnected) {
                try {
                    const pingId = `${Date.now()}_${childDoc.id}`;
                    
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
                    
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childDoc.id)
                        .update({
                            lastPingSent: admin.firestore.FieldValue.serverTimestamp(),
                            lastPingId: pingId
                        });
                    
                    pingsSent++;
                    console.log(`Ping sent to ${child.name}`);
                    
                } catch (error) {
                    console.error(`Failed to ping ${child.name}:`, error.message);
                }
            }
        }
    }
    
    return { pingsSent };
}

async function checkResponsesAndAlert() {
    const familiesSnapshot = await db.collection('families').get();
    let trickstersFound = 0;
    
// TEST: 2 Minuten Timeout (später auf 30 Minuten ändern!)
    const TIMEOUT_MS = 2 * 60 * 1000; // 2 Minuten für Test
    // PRODUKTION: const TIMEOUT_MS = 30 * 60 * 1000; // 30 Minuten
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const familyData = familyDoc.data();
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            
            if (!child.fcmToken || !child.isConnected) continue;
            if (!child.lastPingSent) continue;
            if (child.tricksterBlocked) continue; // Bereits blockiert
            
            const pingSentTime = child.lastPingSent.toDate();
            const responseTime = child.lastPingResponse?.toDate();
            
            const hasResponded = responseTime && responseTime > pingSentTime;
            const timeSincePing = Date.now() - pingSentTime.getTime();
            
            if (!hasResponded && timeSincePing > TIMEOUT_MS) {
                console.log(`TRICKSTER: ${child.name} hat nicht geantwortet!`);
                trickstersFound++;
                
                await db.collection('families').doc(familyId)
                    .collection('children').doc(childDoc.id)
                    .update({
    tricksterBlocked: true,
    tricksterBlockedAt: admin.firestore.FieldValue.serverTimestamp(),
    isResponding: false,
    isPaused: true,
    isActive: false
});
                
                await alertAllParents(familyId, familyData, child);
            }
        }
    }
    
    return { trickstersFound };
}

async function alertAllParents(familyId, familyData, child) {
    const parentTokens = [];
    if (familyData.creatorFCMToken) {
        parentTokens.push(familyData.creatorFCMToken);
    }
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
            console.log(`Alert sent to parent`);
        } catch (error) {
            console.error(`Failed to alert parent:`, error.message);
        }
    }
}
