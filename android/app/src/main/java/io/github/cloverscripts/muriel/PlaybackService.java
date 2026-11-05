package io.github.cloverscripts.muriel;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.ServiceCompat;

/**
 * Keeps Muriel in the foreground while a song plays (Android stops background apps to save memory,
 * which cut the music off) and receives the buttons of the playback notification on Android 12 and
 * older; newer versions call the media session directly. MediaControlsPlugin owns everything else.
 */
public class PlaybackService extends Service {
    static final String ACTION_REFRESH = "io.github.cloverscripts.muriel.REFRESH";
    static final String ACTION_TOGGLE = "io.github.cloverscripts.muriel.TOGGLE";
    static final String ACTION_NEXT = "io.github.cloverscripts.muriel.NEXT";
    static final String ACTION_PREV = "io.github.cloverscripts.muriel.PREV";
    static final String ACTION_DISMISS = "io.github.cloverscripts.muriel.DISMISS";
    static final String ACTION_SHUFFLE = "io.github.cloverscripts.muriel.SHUFFLE_BUTTON";
    static final String ACTION_REPEAT = "io.github.cloverscripts.muriel.REPEAT_BUTTON";
    // the Live Update (the island, MediaControlsPlugin.postIsland) was swiped away
    static final String ACTION_ISLAND_DISMISSED = "io.github.cloverscripts.muriel.ISLAND_DISMISSED";
    // set when started with startForegroundService(): Android then insists on startForeground()
    static final String EXTRA_FOREGROUND = "foreground";
    // Paused, Muriel stays in the foreground this much longer. Android doesn't let an app in the background
    // come back into the foreground on its own, so the next song, or the music coming back after a call,
    // would otherwise stay silent (Android 15+ even stops it).
    static final long PAUSED_FOREGROUND_MS = 10 * 60 * 1000;

    static volatile boolean running;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean foreground;
    private final Runnable leaveForeground = () -> {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
        foreground = false;
    };

    static PendingIntent intent(Context ctx, String action, int requestCode) {
        Intent i = new Intent(ctx, PlaybackService.class).setAction(action);
        return PendingIntent.getService(ctx, requestCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean wasRunning = running;
        running = true;
        String action = intent != null ? intent.getAction() : null;
        MediaControlsPlugin plugin = MediaControlsPlugin.instance;
        if (ACTION_ISLAND_DISMISSED.equals(action)) {
            // the playback notification stays as it is; started just for this, the service goes again
            if (plugin != null) plugin.islandDismissed();
            if (!wasRunning) stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(action) && plugin != null) {
            if (MediaControlsPlugin.playing) plugin.send("pause", -1); else plugin.start("play");
        }
        else if (ACTION_NEXT.equals(action) && plugin != null) plugin.start("next");
        else if (ACTION_PREV.equals(action) && plugin != null) plugin.start("prev");
        else if (ACTION_SHUFFLE.equals(action) && plugin != null) plugin.send("shuffle", -1);
        else if (ACTION_REPEAT.equals(action) && plugin != null) plugin.send("repeat", -1);
        else if (ACTION_DISMISS.equals(action)) { stopSelf(); return START_NOT_STICKY; }
        show(intent != null && intent.getBooleanExtra(EXTRA_FOREGROUND, false));
        return START_NOT_STICKY;
    }

    // foreground while playing and for a while after a pause; then the notification stays but can be swiped away
    private void show(boolean mustStartForeground) {
        Notification n = MediaControlsPlugin.notification;
        if (n == null) { stopSelf(); return; }
        boolean playing = MediaControlsPlugin.playing;
        handler.removeCallbacks(leaveForeground);
        try {
            if (!foreground && (playing || mustStartForeground)) {
                int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
                ServiceCompat.startForeground(this, MediaControlsPlugin.NOTIFICATION_ID, n, type);
                foreground = true;
            } else {
                // also how the notification of a service already in the foreground is updated
                getSystemService(NotificationManager.class).notify(MediaControlsPlugin.NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            // not allowed to go foreground right now (Android 12+ from the background): just show it
            try { getSystemService(NotificationManager.class).notify(MediaControlsPlugin.NOTIFICATION_ID, n); } catch (Exception ignored) {}
        }
        if (foreground && !playing) handler.postDelayed(leaveForeground, PAUSED_FOREGROUND_MS);
    }

    // the app was swiped away: the music stopped with it, so the controls go too
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        MediaControlsPlugin plugin = MediaControlsPlugin.instance;
        if (plugin != null) plugin.shutdown();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(leaveForeground);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
