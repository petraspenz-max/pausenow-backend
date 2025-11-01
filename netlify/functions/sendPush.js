const admin = require('firebase-admin');

// Firebase Admin SDK initialisieren
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'pausenow-daae2'
    });
}

exports.handler = async (event, context) => {
    // CORS Headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
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
        console.log('Unauthorized request blocked');
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Unauthorized' })
        };
    }

    try {
        const requestBody = JSON.parse(event.body);
        
        // NEU: Status Check Action
        if (requestBody.action === 'status_check') {
    const { token, childId } = requestBody;
    
    if (!token || !childId) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ 
                success: false,
                error: 'Token und childId erforderlich für status_check' 
            })
        };
    }
    
    try {
        // Test-Push senden um Token zu validieren
        const testMessage = {
            token: token,
            data: { 
                type: 'status_check',
                timestamp: Date.now().toString()
            },
            apns: {
                headers: {
                    'apns-push-type': 'background',
                    'apns-priority': '10'
                },
                payload: {
                    aps: {
                        "content-available": 1
                    }
                }
            }
        };
        
        await admin.messaging().send(testMessage);
        
        // Token ist gültig - App ist installiert und erreichbar
        // OPTIONAL: Firestore Update (nur wenn sicher ist, dass Dokument existiert)
        try {
            // Verwende set mit merge statt update (erstellt Dokument falls nicht vorhanden)
            await admin.firestore()
                .collection('children')
                .doc(childId)
                .set({
                    lastChecked: admin.firestore.FieldValue.serverTimestamp(),
                    tokenValid: true,
                    isDeleted: false
                }, { merge: true });  // merge: true = erstellt oder updated
            
            console.log(`✅ Firestore updated for child: ${childId}`);
        } catch (firestoreError) {
            // Firestore Fehler ignorieren - wichtig ist nur der Token-Check
            console.log(`⚠️ Firestore update failed (non-critical): ${firestoreError.message}`);
        }
        
        // Response senden - unabhängig vom Firestore Update!
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                status: 'active',
                childId: childId,
                message: 'App ist installiert und erreichbar',
                timestamp: new Date().toISOString()
            })
        };
        
    } catch (error) {
        console.log('Token validation error:', error.code);
        
        // Token ungültig = App gelöscht
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
            
            // OPTIONAL: Als gelöscht markieren (mit robustem Error-Handling)
            try {
                await admin.firestore()
                    .collection('children')
                    .doc(childId)
                    .set({
                        isDeleted: true,
                        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
                        tokenValid: false,
                        isConnected: false
                    }, { merge: true });
                    
                console.log(`✅ Child marked as deleted: ${childId}`);
            } catch (firestoreError) {
                console.log(`⚠️ Firestore update failed (non-critical): ${firestoreError.message}`);
            }
            
            // Response senden - unabhängig vom Firestore Update!
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    status: 'deleted',
                    childId: childId,
                    message: 'App wurde gelöscht',
                    timestamp: new Date().toISOString()
                })
            };
        }
        
        // Andere Fehler = offline oder temporärer Fehler
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                success: true,
                status: 'offline',
                childId: childId,
                message: 'Gerät ist offline oder temporärer Fehler',
                error: error.message,
                timestamp: new Date().toISOString()
            })
        };
    }
}
        
        // BESTEHENDER CODE für normale Push-Nachrichten
        const { token, action, childId, childName, childFCMToken, tokens } = requestBody;

        if ((!token && !tokens) || !action) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Token/Tokens und Action sind erforderlich' })
            };
        }

        console.log(`Push Request: ${action}`);
        console.log(`Single Token: ${token ? token.substring(0, 20) + '...' : 'NONE'}`);
        console.log(`Multi Tokens: ${tokens ? tokens.length : 0}`);
        
        // Multi-Parent: Wenn tokens Array vorhanden, an alle senden
        if (tokens && Array.isArray(tokens)) {
            // WICHTIG: Deduplizierung der Tokens!
            const uniqueTokens = [...new Set(tokens)];
            
            if (uniqueTokens.length !== tokens.length) {
                console.log(`⚠️ Duplicate tokens removed: ${tokens.length} -> ${uniqueTokens.length}`);
            }
            
            const results = [];
            const processedTokens = new Set(); // Verhindere doppelte Verarbeitung
            
            for (const targetToken of uniqueTokens) {
                // Skip wenn bereits verarbeitet
                if (processedTokens.has(targetToken)) {
                    console.log(`⚠️ Skipping duplicate token: ${targetToken.substring(0, 20)}...`);
                    continue;
                }
                processedTokens.add(targetToken);
                
                try {
                    const message = buildMessage(targetToken, action, childId, childName, childFCMToken);
                    const response = await admin.messaging().send(message);
                    results.push({ 
                        token: targetToken.substring(0, 20), 
                        success: true, 
                        messageId: response 
                    });
                    console.log(`✅ Multi-Push sent to: ${targetToken.substring(0, 20)}...`);
                    
                    // Kleine Verzögerung zwischen Nachrichten (verhindert Rate-Limiting)
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                } catch (error) {
                    results.push({ 
                        token: targetToken.substring(0, 20), 
                        success: false, 
                        error: error.message 
                    });
                    console.error(`❌ Multi-Push failed to: ${targetToken.substring(0, 20)}...`, error.message);
                }
            }
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: true, 
                    results: results,
                    action: action,
                    timestamp: new Date().toISOString()
                })
            };
        }
        
        // Single-Parent: Normale Funktionalität (backward compatibility)
        const message = buildMessage(token, action, childId, childName, childFCMToken);
        const response = await admin.messaging().send(message);
        
        console.log(`✅ Single Push sent successfully: ${response}`);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                success: true, 
                messageId: response,
                action: action,
                timestamp: new Date().toISOString()
            })
        };
    } catch (error) {
        console.error('Push Error:', error);
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Failed to send push notification',
                details: error.message 
            })
        };
    }
};

function buildMessage(token, action, childId, childName, childFCMToken) {
    // Basis-Datenstruktur für alle Actions
    const baseData = {
        action: action,
        childId: childId || '',
        childName: childName || '',
        childFCMToken: childFCMToken || '',
        timestamp: Date.now().toString()
    };

    // Action-spezifische Nachrichten
    switch (action) {
        case 'unlock_request':
            return {
                token: token,
                data: baseData,
                apns: {
                    payload: {
                        aps: {
                            "sound": "default",
                            "alert": {
                                "title": "PauseNow",
                                "body": `${childName} möchte freigeschaltet werden`
                            },
                            "critical": 1,
                            "content-available": 1
                        }
                    }
                },
                android: {
                    priority: 'high',
                    notification: {
                        title: "Freischaltungsanfrage",
                        body: `${childName} möchte freigeschaltet werden`
                    },
                    data: baseData
                }
            };

        case 'family_sync':
        case 'child_toggled':
        case 'child_status_sync':
        case 'child_added':
        case 'child_removed':
        case 'child_deleted':
        case 'partner_joined':
        case 'pairing_confirmed':
        case 'parent_token_update':
        case 'child_token_update':
        case 'child_token_sync':
        case 'close_unlock_alerts':
        case 'pause':
        case 'activate':
        default:
            // Silent Push für alle anderen Actions
            return {
                token: token,
                data: baseData,
                apns: {
                    headers: {
                        'apns-priority': '5',
                        'apns-push-type': 'background'
                    },
                    payload: {
                        aps: {
                            "content-available": 1
                        }
                    }
                },
                android: {
                    priority: 'high',
                    data: baseData
                }
            };
    }
}

function getNotificationBody(action, childName) {
    switch (action) {
        case 'pause':
            return 'Deine Apps wurden pausiert';
        case 'activate':
            return 'Deine Apps wurden freigeschaltet';
        case 'unlock_request':
            return `${childName} möchte freigeschaltet werden`;
        case 'pairing_confirmed':
            return 'Gerät erfolgreich verbunden';
        case 'family_sync':
            return 'Familie synchronisiert';
        case 'child_toggled':
            return 'Kind-Status geändert';
        case 'child_status_sync':
            return 'Status synchronisiert';
        case 'child_added':
            return 'Neues Kind hinzugefügt';
        case 'child_deleted':
            return 'Kind entfernt';
        case 'partner_joined':
            return 'Neuer Partner beigetreten';
        default:
            return 'PauseNow Benachrichtigung';
    }
}
