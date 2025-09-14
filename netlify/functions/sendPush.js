const message = {
    token: token,
    data: {
        action: action,
        childId: childId || '',
        childName: childName || '',
        childFCMToken: childFCMToken || '',
        timestamp: Date.now().toString()
    },
    notification: {
        title: 'PauseNow',
        body: getNotificationBody(action, childName)
    },
    apns: {
        headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert'
        },
        payload: {
            aps: {
                'content-available': 1,
                sound: 'default',
                alert: {
                    title: 'PauseNow',
                    body: getNotificationBody(action, childName)
                },
                'interruption-level': 'critical',  // Critical Alert
                'thread-id': 'pausenow-family-controls'
            }
        }
    },
    android: {
        priority: 'high',
        notification: {
            priority: 'high',
            default_sound: true
        }
    }
};
