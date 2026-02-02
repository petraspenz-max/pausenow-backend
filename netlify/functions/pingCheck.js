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
        console.log('=== PINGCHECK STARTED ===');
        console.log('Time:', new Date().toISOString());
        console.log('isScheduled:', isScheduled);
        
        // PHASE 1: Pruefe alte Pings und warne bei Timeout
        const checkResult = await checkResponsesAndAlert();
        
        // PHASE 2: Sende neue Pings
        const pingResult = await sendPingsToAllChildren();
        
        console.log('=== PINGCHECK COMPLETE ===');
        console.log('Pings sent:', pingResult.pingsSent);
        console.log('Tricksters found:', checkResult.trickstersFound);
        
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
    let errors = 0;
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            const childId = childDoc.id;
            
            // Nur Kinder mit Token und Verbindung pingen
            if (!child.fcmToken || child.fcmToken === '') {
                continue;
            }
            
            try {
                const pingId = `${Date.now()}_${childId}`;
                
                // KORRIGIERT: Sende PING (nicht trickster_alert!)
                await admin.messaging().send({
                    token: child.fcmToken,  // KORRIGIERT: child.fcmToken statt token
                    data: {
                        action: 'ping',  // KORRIGIERT: 'ping' statt 'trickster_alert'
                        pingId: pingId,
                        childId: childId,
                        timestamp: Date.now().toString()
                    },
apns: {
    headers: {
        'apns-priority': '5',
        'apns-push-type': 'background'
    },
    payload: {
        aps: {
            'content-available': 1
        },
        action: 'ping',
        pingId: pingId
    }
}
                });
                
                // Ping-Zeitstempel in Firestore speichern
                await db.collection('families').doc(familyId)
                    .collection('children').doc(childId)
                    .update({
                        lastPingSent: admin.firestore.FieldValue.serverTimestamp(),
                        lastPingId: pingId
                    });
                
                pingsSent++;
                console.log(`Ping sent to ${child.name || childId}`);
                
                // Kleine Verzoegerung zwischen Nachrichten
                await new Promise(resolve => setTimeout(resolve, 50));
                
            } catch (error) {
                errors++;
                
                // Token ungueltig = App geloescht
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    console.log(`Token invalid for ${child.name || childId} - App deleted`);
                    
                    // Markiere als geloescht
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childId)
                        .update({
                            isResponding: false,
                            tokenInvalid: true,
                            tokenInvalidAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                } else {
                    console.error(`Failed to ping ${child.name || childId}:`, error.message);
                }
            }
        }
    }
    
    return { pingsSent, errors };
}

async function checkResponsesAndAlert() {
    const familiesSnapshot = await db.collection('families').get();
    let trickstersFound = 0;
    
    // Timeout: 6 Minuten ohne Ping-Antwort
    const PING_TIMEOUT_MS = 6 * 60 * 1000;
    // App gilt als "laufend" wenn lastSeen < 3 Minuten alt
    const APP_RUNNING_THRESHOLD_MS = 3 * 60 * 1000;
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const familyData = familyDoc.data();
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            const childId = childDoc.id;
            
            // Skip: Kein Token, bereits blockiert, oder kein Ping gesendet
            if (!child.fcmToken || child.fcmToken === '') continue;
            if (!child.lastPingSent) continue;
            if (child.tricksterBlocked) continue;
            
            const pingSentTime = child.lastPingSent.toDate();
            const responseTime = child.lastPingResponse?.toDate();
            const lastSeenTime = child.lastSeen?.toDate();
            
            const hasResponded = responseTime && responseTime > pingSentTime;
            const timeSincePing = Date.now() - pingSentTime.getTime();
            
            // Prüfe ob App läuft (lastSeen ist aktuell)
            const appIsRunning = lastSeenTime && 
                (Date.now() - lastSeenTime.getTime() < APP_RUNNING_THRESHOLD_MS);
            
            // Keine Antwort nach Timeout?
            if (!hasResponded && timeSincePing > PING_TIMEOUT_MS) {
                
                if (appIsRunning) {
                    // TRICKSTER: App läuft, aber Pings kommen nicht an!
                    // = Mitteilungen sind AUS!
                    console.log(`=== TRICKSTER DETECTED ===`);
                    console.log(`Child: ${child.name || childId}`);
                    console.log(`lastSeen: ${lastSeenTime?.toISOString()} (App is running!)`);
                    console.log(`lastPingResponse: ${responseTime?.toISOString() || 'NEVER'}`);
                    console.log(`Reason: App running but no ping response = Notifications OFF`);
                    
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childId)
                        .update({
                            isResponding: false,
                            tricksterBlocked: true,
                            tricksterBlockedAt: admin.firestore.FieldValue.serverTimestamp(),
                            isPaused: true,
                            isActive: false
                        });
                    
                    // Eltern benachrichtigen
                    await alertAllParents(familyId, familyData, {...child, id: childId});
                    trickstersFound++;
                    
                } else {
                    // OFFLINE: App läuft nicht oder Kind ist offline
                    // KEIN Trickster - nur offline markieren
                    console.log(`=== CHILD OFFLINE ===`);
                    console.log(`Child: ${child.name || childId}`);
                    console.log(`lastSeen: ${lastSeenTime?.toISOString() || 'NEVER'} (App not running)`);
                    console.log(`Reason: App not running or device offline - NOT a trickster`);
                    
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childId)
                        .update({
                            isResponding: false
                            // KEIN tricksterBlocked!
                        });
                }
            } else if (hasResponded) {
                // Kind hat geantwortet - alles OK
                await db.collection('families').doc(familyId)
                    .collection('children').doc(childId)
                    .update({
                        isResponding: true
                    });
            }
        }
    }
    
    return { trickstersFound };
}

async function alertAllParents(familyId, familyData, child) {
    const parentTokens = [];
    
    // parentTokens Array
    if (familyData.parentTokens && Array.isArray(familyData.parentTokens)) {
        parentTokens.push(...familyData.parentTokens);
    }
    
    // Fallback fuer alte Struktur
    if (familyData.creatorFCMToken) {
        parentTokens.push(familyData.creatorFCMToken);
    }
    if (familyData.partnerTokens && Array.isArray(familyData.partnerTokens)) {
        parentTokens.push(...familyData.partnerTokens);
    }
    
    // Deduplizierung
    const uniqueTokens = [...new Set(parentTokens)];
    
    console.log(`Alerting ${uniqueTokens.length} parents for ${child.name}`);
    
    for (const token of uniqueTokens) {
        if (!token || token === '') continue;
        
        try {
            await admin.messaging().send({
                token: token,
                data: {
                    action: 'trickster_alert',
                    childId: child.id || '',
                    childName: child.name || ''
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                            alert: {
                                title: 'PauseNow',
                                'loc-key': 'trickster_alert_message',
                                'loc-args': [child.name || 'Kind']
                            }
                        }
                    }
                }
            });
            console.log(`Trickster alert sent to parent`);
        } catch (error) {
            console.error(`Failed to alert parent:`, error.message);
        }
    }
}
