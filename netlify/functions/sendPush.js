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
        'Access-Control-Allow-Headers': 'Content-Type',
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

    try {
        const { token, action, childId, childName, childFCMToken } = JSON.parse(event.body);

        if (!token || !action) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Token und Action sind erforderlich' })
            };
        }

        console.log(`Push Request: ${action} to ${token.substring(0, 20)}...`);
        console.log(`childFCMToken received: ${childFCMToken ? childFCMToken.substring(0, 20) + '...' : 'NOT PROVIDED'}`);
        
        // Conditional Message basierend auf Action
        let message;

        if (action === 'unlock_request') {
            // Alert Push für Unlock Requests
            message = {
                token: token,
                data: {
                    action: action,
                    childId: childId || '',
                    childName: childName || '',
                    childFCMToken: childFCMToken || '',
                    timestamp: Date.now().toString()
                },
                apns: {
                    payload: {
                        aps: {
                            "alert": {
                                "title": "Freischaltungsanfrage", 
                                "body": childName + " möchte freigeschaltet werden"
                            },
                            "sound": "default",
                            "content-available": 1
                        }
                    }
                },
                android: {
                    priority: 'high',
                    notification: {
                        title: "Freischaltungsanfrage",
                        body: childName + " möchte freigeschaltet werden"
                    },
                    data: {
                        action: action,
                        childId: childId || '',
                        childName: childName || '',
                        childFCMToken: childFCMToken || ''
                    }
                }
            };
        } else {
            // Silent Push für alle anderen Actions (pause, activate, etc.)
            message = {
                token: token,
                data: {
                    action: action,
                    childId: childId || '',
                    childName: childName || '',
                    childFCMToken: childFCMToken || '',
                    timestamp: Date.now().toString()
                },
                apns: {
                    headers: {
                        'apns-priority': '10',
                        'apns-push-type': 'background'
                        'apns-expiration': Math.floor(Date.now() / 1000) + 1800
                    },
                    payload: {
                        aps: {
                            "content-available": 1
                        }
                    }
                },
                android: {
                    priority: 'high',
                    data: {
                        action: action,
                        childId: childId || '',
                        childName: childName || '',
                        childFCMToken: childFCMToken || ''
                    }
                }
            };
        }

        const response = await admin.messaging().send(message);
        
        console.log(`✅ Push sent successfully: ${response}`);
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
        default:
            return 'PauseNow Benachrichtigung';
    }
}
