const admin = require('firebase-admin');
const { schedule } = require('@netlify/functions');

// Firebase Admin SDK initialisieren
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'pausenow-daae2'
    });
}

const db = admin.firestore();

exports.handler = schedule('*/2 * * * *', async () => {
    try {
        console.log('=== PINGCHECK STARTED (scheduled) ===');
        console.log('Time:', new Date().toISOString());

        // PHASE 1: Pruefe Antworten auf letzte Pings (isResponding tracken)
        const checkResult = await checkResponses();

        // PHASE 2: Sende neue Pings an alle Kinder
        const pingResult = await sendPingsToAllChildren();

        console.log('=== PINGCHECK COMPLETE ===');
        console.log('Pings sent:', pingResult.pingsSent);
        console.log('Not responding:', checkResult.notResponding);
        console.log('Offline children:', checkResult.offlineChildren);

        return { statusCode: 200 };

    } catch (error) {
        console.error('PingCheck Error:', error);
        return { statusCode: 500 };
    }
});

// PHASE 1: Pruefe ob Kinder auf Pings antworten
// Setzt NUR isResponding - KEINE Trickster-Logik!
// Trickster-Erkennung laeuft ausschliesslich auf dem Kind-Geraet
// (DeviceActivityMonitorExtension + FamilyManager)
async function checkResponses() {
    const familiesSnapshot = await db.collection('families').get();
    let notResponding = 0;
    let offlineChildren = 0;
    
    // Timeout: 10 Minuten ohne Ping-Antwort
    const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
    
    for (const familyDoc of familiesSnapshot.docs) {
        const familyId = familyDoc.id;
        const childrenSnapshot = await db.collection('families').doc(familyId)
            .collection('children').get();
        
        for (const childDoc of childrenSnapshot.docs) {
            const child = childDoc.data();
            const childId = childDoc.id;
            
            // Skip: Kein Token, bereits blockiert, oder kein Ping gesendet
            if (!child.fcmToken || child.fcmToken === '') continue;
            if (!child.lastPingSent) continue;
            if (child.tricksterBlocked) continue;
            if (child.isActive === false) continue;
            
            const responseTime = child.lastPingResponse?.toDate();
            
            const timeSinceLastResponse = responseTime 
                ? Date.now() - responseTime.getTime() 
                : Infinity;
            
            if (timeSinceLastResponse > RESPONSE_TIMEOUT_MS) {
                // Kind antwortet nicht - nur isResponding tracken
                if (child.isResponding !== false) {
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childId)
                        .update({
                            isResponding: false
                        });
                }
                
                console.log(`${childId}: Not responding (${Math.round(timeSinceLastResponse / 60000)} min)`);
                notResponding++;
                
            } else {
                // Kind antwortet - Status aktualisieren
                if (child.isResponding !== true) {
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childId)
                        .update({
                            isResponding: true,
                            missedPingCount: 0
                        });
                    console.log(`${childId}: Responding OK`);
                }
            }
        }
    }
    
    return { notResponding, offlineChildren };
}

// PHASE 2: Sende Pings an alle Kinder
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
            
            // Nur Kinder mit Token pingen
            if (!child.fcmToken || child.fcmToken === '') {
                continue;
            }
            
            try {
                const pingId = `${Date.now()}_${childId}`;
                
                await admin.messaging().send({
                    token: child.fcmToken,
                    data: {
                        action: 'ping',
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
                console.log(`Ping sent to ${childId}`);
                
                // Kleine Verzoegerung zwischen Nachrichten
                await new Promise(resolve => setTimeout(resolve, 50));
                
            } catch (error) {
                errors++;
                
                // Token ungueltig = App geloescht
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    console.log(`Token invalid for ${childId} - App deleted`);
                    
                    await db.collection('families').doc(familyId)
                        .collection('children').doc(childId)
                        .update({
                            isResponding: false,
                            tokenInvalid: true,
                            tokenInvalidAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                } else {
                    console.error(`Failed to ping ${childId}:`, error.message);
                }
            }
        }
    }
    
    return { pingsSent, errors };
}
