const admin = require('firebase-admin');

// Firebase Admin SDK initialisieren
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'pausenow-daae2'
    });
}

// ===== (Z) Angriff #1 — sendPush-Haertung (Track 1) =====
// - fail-closed: kein Dev-Key-Fallback (PAUSENOW_API_KEY Pflicht)
// - Zahn-Actions pause/activate: idToken-Verify + Ownership (memberIds & !removedUIDs)
//   + Target-Binding (children/{childId}.fcmToken == token)
// - family_deleted: NIE ueber sendPush legitim (CF-only) -> hart 403
// - unpair_device: bleibt in Track 1 im Dual-Accept, wandert in Track 2 in eine eigene CF
// - Dual-Accept via ENFORCE_TOOTH_IDTOKEN (Flip zusammen mit dem Rules-Flip)

// Lokalisierte Strings für Push-Nachrichten (Fallback wenn iOS nichts sendet)
const translations = {
    en: {
        paused: "Device paused",
        activated: "Device activated",
        unlockRequest: "wants to be unlocked"
    },
    de: {
        paused: "Gerät pausiert",
        activated: "Gerät aktiviert",
        unlockRequest: "möchte freigeschaltet werden"
    },
    fr: {
        paused: "Appareil en pause",
        activated: "Appareil activé",
        unlockRequest: "souhaite être débloqué"
    },
    es: {
        paused: "Dispositivo pausado",
        activated: "Dispositivo activado",
        unlockRequest: "quiere ser desbloqueado"
    },
    it: {
        paused: "Dispositivo in pausa",
        activated: "Dispositivo attivato",
        unlockRequest: "vuole essere sbloccato"
    },
    ja: {
        paused: "デバイスが一時停止中",
        activated: "デバイスが有効になりました",
        unlockRequest: "ロック解除をリクエストしています"
    },
    ko: {
        paused: "기기 일시정지됨",
        activated: "기기 활성화됨",
        unlockRequest: "잠금 해제를 요청합니다"
    }
};

// Hilfsfunktion: Sprache ermitteln (Fallback: Englisch)
function getTranslation(lang) {
    const langCode = (lang || 'en').substring(0, 2).toLowerCase();
    return translations[langCode] || translations.en;
}

exports.handler = async (event, context) => {
    // CORS Headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Authorization',
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
    const API_KEY = process.env.PAUSENOW_API_KEY;
    const requestKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];

    if (!API_KEY) {
        console.error('PAUSENOW_API_KEY not configured - failing closed');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
    }
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
        
        // Status Check Action
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
                
                // Token ist gültig - Return HIER sofort!
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        status: 'active',
                        childId: childId,
                        message: 'App ist installiert',
                        timestamp: new Date().toISOString()
                    })
                };
                
            } catch (error) {
                console.log('Token validation error:', error.code);
                
                // Token ungültig = App gelöscht
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    
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
                
                // Andere Fehler = offline
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ 
                        success: true,
                        status: 'offline',
                        childId: childId,
                        message: 'Gerät ist offline',
                        timestamp: new Date().toISOString()
                    })
                };
            }
        }
        
        // BESTEHENDER CODE für normale Push-Nachrichten
        const { token, action, childId, childName, childFCMToken, tokens, language, notification, senderToken } = requestBody;
        
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
        console.log(`Language: ${language || 'en (default)'}`);
        console.log(`ChildId: ${childId || 'NONE'}`);
        console.log(`iOS Notification: ${notification ? 'YES (title: ' + notification.title + ')' : 'NO (using fallback)'}`);

        // ===== (Z) Angriff #1: Zahn-Action-Gate =====
        // Shield-relevante Actions duerfen nicht allein mit dem (extrahierbaren) Shared Key
        // ausgeloest werden. Ownership wird serverseitig erzwungen.
        const TOOTH_ACTIONS = ['pause', 'activate'];
        const CF_ONLY_ACTIONS = ['family_deleted', 'unpair_device']; // unpair laeuft jetzt ueber CF unpairChild -> sendPush hart 403
        const ENFORCE_TOOTH_IDTOKEN = process.env.ENFORCE_TOOTH_IDTOKEN === 'true';

        // family_deleted kommt ausschliesslich aus onFamilyDeleted / cleanupInactiveFamilies
        // (Admin-SDK direkt) -> ueber sendPush IMMER ablehnen.
        if (CF_ONLY_ACTIONS.includes(action)) {
            console.log(`Blocked CF-only action via sendPush: ${action}`);
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Action not allowed via sendPush' }) };
        }

        if (TOOTH_ACTIONS.includes(action)) {
            const authz = event.headers['authorization'] || event.headers['Authorization'] || '';
            const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;

            if (!idToken) {
                // Dual-Accept: Clients ohne idToken (Alt/Frozen) noch via Key durchlassen.
                // Flip ENFORCE_TOOTH_IDTOKEN=true (Schritt 8, mit Rules-Flip) -> 403.
                if (ENFORCE_TOOTH_IDTOKEN) {
                    console.log(`Tooth-action without idToken rejected (enforced): ${action}`);
                    return { statusCode: 403, headers, body: JSON.stringify({ error: 'idToken required' }) };
                }
                console.log(`LEGACY tooth-action without idToken (dual-accept): ${action}`);
            } else {
                // idToken vorhanden -> IMMER verifizieren + Ownership erzwingen.
                // checkRevoked=true honoriert revokePartner.revokeRefreshTokens (Defense-in-Depth).
                // Faellt es je bei legitimen Eltern falsch-positiv aus: zweites Argument entfernen
                // -> die removedUIDs-Pruefung unten haelt die Linie weiterhin.
                let decoded;
                try {
                    decoded = await admin.auth().verifyIdToken(idToken, true);
                } catch (e) {
                    console.log(`Invalid/revoked idToken: ${e.message}`);
                    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid idToken' }) };
                }
                const callerUid = decoded.uid;

                const { familyId } = requestBody;
                if (!familyId) {
                    return { statusCode: 400, headers, body: JSON.stringify({ error: 'familyId required for this action' }) };
                }
                if (!childId) {
                    return { statusCode: 400, headers, body: JSON.stringify({ error: 'childId required for this action' }) };
                }

                const db = admin.firestore();
                const famSnap = await db.collection('families').doc(familyId).get();
                if (!famSnap.exists) {
                    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Family not found' }) };
                }
                const fam = famSnap.data();
                const isMember = Array.isArray(fam.memberIds) && fam.memberIds.includes(callerUid);
                const isRemoved = Array.isArray(fam.removedUIDs) && fam.removedUIDs.includes(callerUid);
                if (!isMember || isRemoved) {
                    console.log(`Ownership denied: caller ${callerUid} not member / removed for ${familyId}`);
                    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not authorized for this family' }) };
                }

                // Target-Binding: Ziel-Token muss zum Kind DIESER Familie gehoeren
                // -> verhindert, dass ein Mitglied von Familie A an ein Kind von Familie B pusht.
                const childSnap = await db.collection('families').doc(familyId)
                    .collection('children').doc(childId).get();
                if (!childSnap.exists) {
                    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Child not in this family' }) };
                }
                if (childSnap.data().fcmToken !== token) {
                    console.log('Target token does not match child fcmToken');
                    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Target token mismatch' }) };
                }
                console.log(`Ownership OK: ${callerUid} -> ${familyId}/${childId}`);
            }
        }
        // ===== Ende Zahn-Action-Gate =====
        
        // Multi-Parent: Wenn tokens Array vorhanden, an alle senden
        if (tokens && Array.isArray(tokens)) {
            // WICHTIG: Deduplizierung der Tokens!
            const uniqueTokens = [...new Set(tokens)];
            
            if (uniqueTokens.length !== tokens.length) {
                console.log(`Duplicate tokens removed: ${tokens.length} -> ${uniqueTokens.length}`);
            }
            
            const results = [];
            const processedTokens = new Set();
            
            for (const targetToken of uniqueTokens) {
                if (processedTokens.has(targetToken)) {
                    console.log(`Skipping duplicate token: ${targetToken.substring(0, 20)}...`);
                    continue;
                }
                processedTokens.add(targetToken);
                
                try {
                    const message = buildMessage(targetToken, action, childId, childName, childFCMToken, language, notification, senderToken)
                    const response = await admin.messaging().send(message);
                    results.push({ 
                        token: targetToken.substring(0, 20), 
                        success: true, 
                        messageId: response 
                    });
                    console.log(`Multi-Push sent to: ${targetToken.substring(0, 20)}...`);
                    
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                } catch (error) {
                    if (error.code === 'messaging/invalid-registration-token' ||
                        error.code === 'messaging/registration-token-not-registered') {
                        results.push({ 
                            token: targetToken.substring(0, 20), 
                            success: false, 
                            error: 'NotRegistered',
                            deleted: true
                        });
                        console.log(`Token invalid - App deleted: ${targetToken.substring(0, 20)}...`);
                    } else {
                        results.push({ 
                            token: targetToken.substring(0, 20), 
                            success: false, 
                            error: error.message 
                        });
                        console.error(`Multi-Push failed to: ${targetToken.substring(0, 20)}...`, error.message);
                    }
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
        const message = buildMessage(token, action, childId, childName, childFCMToken, language, notification, senderToken)
        const response = await admin.messaging().send(message);
        
        console.log(`Single Push sent successfully: ${response}`);
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
        console.error('Error Code:', error.code);
        
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
            
            console.log('Token ungültig - App wurde gelöscht');
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: false,
                    error: 'NotRegistered',
                    message: 'Token ist nicht mehr registriert - App wurde gelöscht',
                    timestamp: new Date().toISOString()
                })
            };
        }
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Failed to send push notification',
                details: error.message,
                code: error.code || 'unknown'
            })
        };
    }
};

function buildMessage(token, action, childId, childName, childFCMToken, language, notification, senderToken) {
    // Lokalisierte Texte holen (Fallback)
    const t = getTranslation(language);
    
    const hasIOSNotification = notification && notification.title && notification.body;
    
    // Basis-Datenstruktur für alle Actions
    const baseData = {
        action: action,
        childId: childId || '',
        childName: childName || '',
        childFCMToken: childFCMToken || '',
        timestamp: Date.now().toString()
    };

    // senderToken nur hinzufuegen wenn vorhanden
    if (senderToken && typeof senderToken === 'string' && senderToken.length > 0) {
        baseData.senderToken = senderToken;
    }

    // Action-spezifische Nachrichten
    switch (action) {
        case 'unlock_request':
            console.log(`unlock_request: Using loc-key with childId="${childId}"`);
            
            return {
                token: token,
                data: baseData,
                apns: {
                    payload: {
                        aps: {
                            "sound": "default",
                            "badge": 1,
                            "alert": {
                                "title": "PauseNow",
                                "loc-key": "notification_unlock_request_body",
                                "loc-args": [childName || "Kind"]
                            },
                            "critical": 1,
                            "content-available": 1
                        }
                    }
                },
                android: {
                    priority: 'high',
                    notification: {
                        title: "PauseNow",
                        body: `${childName} ${t.unlockRequest}`
                    },
                    data: baseData
                }
            };

        case 'pause':
        case 'activate':
            const isPause = action === 'pause';
            const titleLocKey = isPause ? "notification_pause_title" : "notification_activate_title";
            const bodyLocKey = isPause ? "notification_pause_body" : "notification_activate_body";
            const alertBadge = isPause ? 1 : 0;
            
            console.log(`${action}: Using loc-key "${titleLocKey}" / "${bodyLocKey}"`);
            
            return {
                token: token,
                data: baseData,
                apns: {
                    headers: {
                        'apns-priority': '10',
                        'apns-push-type': 'alert',
                        'apns-expiration': String(Math.floor(Date.now() / 1000) + (28 * 24 * 60 * 60))
                    },
                    payload: {
                        aps: {
                            "mutable-content": 1,
                            "content-available": 1,
                            "sound": "default",
                            "badge": alertBadge,
                            "alert": {
                                "title-loc-key": titleLocKey,
                                "loc-key": bodyLocKey
                            }
                        },
                        action: action
                    }
                },
                android: {
                    priority: 'high',
                    notification: {
                        title: isPause ? t.paused : t.activated,
                        body: isPause ? "You can make phone calls!" : "You can use all apps!"
                    },
                    data: baseData
                }
            };

        // Build 143: pause_confirmed und activate_confirmed als alert-push
        // mit content-available, ohne sichtbare notification.
        // Loest Phantom-Offline-Bug: silent pushes wurden im Background gedrosselt.
        case 'pause_confirmed':
        case 'activate_confirmed':
            console.log(`${action}: Reliable background-wake push (Build 143)`);
            
            return {
                token: token,
                data: baseData,
                apns: {
                    headers: {
                        'apns-priority': '10',
                        'apns-push-type': 'alert',
                        'apns-expiration': String(Math.floor(Date.now() / 1000) + (5 * 60))
                    },
                    payload: {
                        aps: {
                            "mutable-content": 1,
                            "content-available": 1
                        },
                        action: action
                    }
                },
                android: {
                    priority: 'high',
                    data: baseData
                }
            };

        case 'ping':
            return {
                token: token,
                data: {
                    ...baseData,
                    pingId: Date.now().toString()
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
                        pingId: Date.now().toString()
                    }
                },
                android: {
                    priority: 'high',
                    data: baseData
                }
            };

        case 'trickster_alert':
            console.log(`trickster_alert: Using loc-key with childId="${childId}"`);
            return {
                token: token,
                data: baseData,
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                            alert: {
                                title: 'PauseNow',
                                'loc-key': 'trickster_alert_message',
                                'loc-args': [childName || 'Kind']
                            }
                        }
                    }
                },
                android: {
                    priority: 'high',
                    notification: {
                        title: 'PauseNow',
                        body: `${childName} hat versucht die Kontrolle zu umgehen.`
                    },
                    data: baseData
                }
            };

        case 'permission_lost':
            console.log(`permission_lost: Using loc-key with childId="${childId}"`);
            return {
                token: token,
                data: baseData,
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
                        body: `Bei ${childName} fehlt die Bildschirmzeit-Freigabe. Bitte Gerät prüfen.`
                    },
                    data: baseData
                }
            };

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
